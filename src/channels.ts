import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Framework } from './index.js';
import type { Actor } from './types.js';
import { contentHash } from './contracts.js';
import { fail, FrameworkError } from './errors.js';
import { requireAdmin } from './admin.js';
import { authenticateRequest } from './console-auth.js';
export interface Channel {
    id: string; name: string; kind: 'model' | 'plugin'; protocol: 'anthropic' | 'company-jsonrpc' | 'http'; provider: string;
    baseURL: string; model?: string; accountGroup: string; maxConcurrency: number; priority: number; enabled: boolean;
    scope: 'company' | 'department' | 'personal'; departmentId?: string; ownerId?: string; documentation: string;
    source?: 'environment'; revision?: string;
}
const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' };
const bodySchema = { type: 'object', additionalProperties: false, required: ['id','name','kind','protocol','provider','baseURL','accountGroup','maxConcurrency','priority','scope','enabled'], properties: {
    id, name: { type:'string', minLength:1,maxLength:80 }, kind:{enum:['model','plugin']},protocol:{enum:['anthropic','company-jsonrpc','http']},provider:id,
    baseURL:{type:'string',minLength:1,maxLength:300},model:{type:'string',minLength:1,maxLength:100},accountGroup:id,maxConcurrency:{type:'integer',minimum:1,maximum:128},priority:{type:'integer',minimum:0,maximum:100},scope:{enum:['company','department','personal']},departmentId:id,ownerId:id,enabled:{type:'boolean'},documentation:{type:'string',maxLength:16000},apiKey:{type:'string',minLength:1,maxLength:4096},revision:{type:'string',pattern:'^[a-f0-9]{64}$'}
} };
export class Channels {
    private key!: Buffer;
    private fallback?: { key: string; url: string; model: string };
    constructor(readonly host: Framework) {}
    async open() {
        await mkdir(this.host.options.root,{recursive:true}); const path=resolve(this.host.options.root,'.channel-vault-key');
        try { await writeFile(path,randomBytes(32),{mode:0o600,flag:'wx'}); } catch(e) { if((e as any).code!=='EEXIST')throw e; }
        this.key=await readFile(path); if(this.key.length!==32)fail('UNAVAILABLE','Channel vault key is invalid');
    }
    configureFallback(key:string,url:string,model:string){this.fallback=key?{key,url,model}:undefined;}
    private encrypt(secret:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);return [iv.toString('base64'),Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]).toString('base64'),cipher.getAuthTag().toString('base64')].join('.');}
    private decrypt(secret:string){const [iv,data,tag]=secret.split('.');const cipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(iv!,'base64'));cipher.setAuthTag(Buffer.from(tag!,'base64'));return Buffer.concat([cipher.update(Buffer.from(data!,'base64')),cipher.final()]).toString('utf8');}
    private visible(actor:Actor,data:Channel){return actor.role==='admin'||data.scope==='company'||(data.scope==='personal'&&data.ownerId===actor.id)||(data.scope==='department'&&!!actor.departmentId&&actor.departmentId===data.departmentId);}
    private accountKey(companyId:string,data:Channel,environmentGroup:boolean){return environmentGroup?contentHash(['host-environment',this.fallback?.key]):contentHash([companyId,data.provider,data.accountGroup]);}
    private async ensureDefault(companyId:string){
        if(!this.fallback)return;
        const data:Channel={id:'environment-default',name:'现有 DeepSeek 渠道',kind:'model',protocol:'anthropic',provider:'deepseek',baseURL:this.fallback.url,model:this.fallback.model,accountGroup:'environment-default',maxConcurrency:3,priority:50,scope:'company',enabled:true,documentation:'沿用服务器环境凭证。相同账号的其他Key请使用相同账号组；禁用后不会继续作为隐式兜底。',source:'environment'};
        await this.host.db.pool.query('INSERT INTO provider_channels(company_id,id,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[companyId,data.id,JSON.stringify(data)]);
    }
    private public(row:any){return {...row.data,revision:contentHash({data:row.data,credential:row.credential}),hasCredential:!!row.credential||(row.data.source==='environment'&&!!this.fallback),cooldownUntil:row.cooldown_until,lastStatus:row.last_status,activeRequests:row.active_requests??0,...(row.accountActiveRequests!==undefined?{accountActiveRequests:row.accountActiveRequests}:{}),...(row.usage?{usage:row.usage}:{})};}
    async list(principalId:string,administrative=false){
        const actor=await this.host.db.get<Actor>('actors',principalId);if(!actor.active)fail('PERMISSION_DENIED','Employee is inactive');if(administrative)await requireAdmin(this.host,principalId);
        await this.ensureDefault(actor.companyId);
        const rows=(await this.host.db.pool.query('SELECT c.*,(SELECT count(*)::int FROM channel_leases l WHERE l.company_id=c.company_id AND l.channel_id=c.id AND l.expires_at>now()) AS active_requests FROM provider_channels c WHERE company_id=$1 ORDER BY (data->>\'priority\')::int,id',[actor.companyId])).rows;
        if(administrative){
            const stats=(await this.host.db.pool.query("SELECT u.data->>'channelId' AS id,count(*)::int AS requests,count(*) FILTER(WHERE u.data->>'measurement'='unavailable')::int AS unmeasured,coalesce(sum((u.data->>'inputTokens')::bigint),0)::text AS input_tokens,coalesce(sum((u.data->>'outputTokens')::bigint),0)::text AS output_tokens FROM usage u JOIN agents a ON a.id=u.data->>'agentId' WHERE a.data->>'companyId'=$1 AND u.created_at>now()-interval '7 days' AND u.data->>'channelId' IS NOT NULL GROUP BY u.data->>'channelId'",[actor.companyId])).rows;
            const leases=(await this.host.db.pool.query('SELECT account_group,count(*)::int AS n FROM channel_leases WHERE expires_at>now() GROUP BY account_group')).rows;
            for(const row of rows){row.usage=stats.find(s=>s.id===row.id)??{requests:0,input_tokens:'0',output_tokens:'0',unmeasured:0};const environmentGroup=rows.some(c=>c.data.source==='environment'&&c.data.provider===row.data.provider&&c.data.accountGroup===row.data.accountGroup);row.accountActiveRequests=leases.find(l=>l.account_group===this.accountKey(actor.companyId,row.data,environmentGroup))?.n??0;}
        }
        return rows.filter(r=>administrative||this.visible(actor,r.data)).map(r=>this.public(r));
    }
    async save(principalId:string,input:Channel&{apiKey?:string},create:boolean){
        if(!this.host.registry.ajv.validate(bodySchema,input))fail('INVALID_INPUT','Invalid channel configuration');
        let url:URL;try{url=new URL(input.baseURL);}catch{fail('INVALID_INPUT','Invalid channel address');}
        if(url!.username||url!.password||url!.search||url!.hash||(url!.protocol!=='https:'&&!(url!.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url!.hostname))))fail('INVALID_INPUT','Use HTTPS, or loopback HTTP for a local provider');
        if(input.kind==='model'&&(input.protocol!=='anthropic'||!input.model))fail('INVALID_INPUT','Model channels require the Anthropic-compatible protocol and a model name');
        if(input.kind==='plugin'&&input.protocol==='anthropic')fail('INVALID_INPUT','Select a plugin connection protocol');
        const client=await this.host.db.pool.connect();
        try{
            await client.query('BEGIN');await this.host.organization.lock(client);const actor=await requireAdmin(this.host,principalId,client);
            const prior=(await client.query('SELECT * FROM provider_channels WHERE company_id=$1 AND id=$2 FOR UPDATE',[actor.companyId,input.id])).rows[0];
            if(create&&prior)fail('CONFLICT','Channel already exists');if(!create&&!prior)fail('NOT_FOUND','Channel does not exist');
            if(prior&&input.revision!==contentHash({data:prior.data,credential:prior.credential}))fail('CONFLICT','Channel changed; reload before saving');
            if(prior&&(input.scope!==prior.data.scope||input.ownerId!==prior.data.ownerId||input.kind!==prior.data.kind))fail('CONFLICT','Channel ownership, visibility and kind are fixed; create another resource');
            if(input.scope==='personal') {const owner=await this.host.db.get<Actor>('actors',input.ownerId!,client);if(owner.companyId!==actor.companyId||!owner.active)fail('PERMISSION_DENIED','Select an active employee in this company');}
            if(input.scope==='department'){const department=(await client.query('SELECT data FROM departments WHERE id=$1',[input.departmentId])).rows[0]?.data;if(!department?.active||department.companyId!==actor.companyId)fail('PERMISSION_DENIED','Select an active company department');}
            const siblings=(await client.query("SELECT id,data FROM provider_channels WHERE company_id=$1 AND data->>'provider'=$2 AND data->>'accountGroup'=$3 AND id<>$4",[actor.companyId,input.provider,input.accountGroup,input.id])).rows;
            if(siblings.some(s=>s.data.maxConcurrency!==input.maxConcurrency))fail('CONFLICT','Keys in the same account group must have the same concurrency limit');
            const {apiKey,revision,...fields}=input;const data={...fields,documentation:input.documentation??'',...(prior?.data.source&&!apiKey?{source:prior.data.source}:{})};
            const credential=apiKey?this.encrypt(apiKey):prior?.credential??null;
            if(input.enabled&&!credential&&data.source!=='environment'&&input.kind==='model')fail('INVALID_INPUT','Add a credential before enabling a model channel');
            const row=(await client.query('INSERT INTO provider_channels(company_id,id,data,credential) VALUES($1,$2,$3,$4) ON CONFLICT(company_id,id) DO UPDATE SET data=EXCLUDED.data,credential=EXCLUDED.credential,cooldown_until=NULL,last_status=NULL RETURNING *',[actor.companyId,input.id,JSON.stringify(data),credential])).rows[0];
            await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)',[randomUUID(),'channel.saved',JSON.stringify({principalId:actor.id,companyId:actor.companyId,channelId:input.id,kind:input.kind,credentialChanged:!!apiKey,enabled:input.enabled})]);
            await client.query('COMMIT');return this.public(row);
        }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    }
    async resolveConnection(principalId:string,reference:string){
        const actor=await this.host.db.get<Actor>('actors',principalId),id=reference.replace(/^connection:/u,'');
        const row=(await this.host.db.pool.query('SELECT * FROM provider_channels WHERE company_id=$1 AND id=$2',[actor.companyId,id])).rows[0];
        if(!row)return null;
        if(!actor.active||!row.data.enabled||!this.visible(actor,row.data)||row.data.kind!=='plugin')fail('PERMISSION_DENIED','Connection is not available to this employee');
        if(row.data.protocol!=='company-jsonrpc')fail('UNSUPPORTED_CAPABILITY','This HTTP platform needs a plugin adapter; a URL alone is not an executable tool');
        return {url:row.data.baseURL,token:row.credential?this.decrypt(row.credential):undefined,revision:contentHash({data:row.data,credential:row.credential})};
    }
    async hasModel(principalId:string,model:string){return(await this.list(principalId)).some(c=>c.kind==='model'&&c.model===model&&c.enabled&&c.hasCredential);}
    private async acquire(principalId:string,model:string,excluded:Set<string>){
        const client=await this.host.db.pool.connect();try{
            await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[this.host.db.schema+':channel-admission']);
            const actor=await this.host.db.get<Actor>('actors',principalId,client);if(!actor.active)fail('PERMISSION_DENIED','Employee is inactive');
            await client.query('DELETE FROM channel_leases WHERE expires_at<=now()');
            const own=(await client.query('SELECT count(*)::int AS n FROM channel_leases WHERE principal_id=$1',[actor.id])).rows[0].n;
            if(own>=2){await client.query('COMMIT');return null;}
            const rows=(await client.query("SELECT * FROM provider_channels WHERE company_id=$1 AND data->>'kind'='model' AND data->>'model'=$2 AND data->>'enabled'='true' AND (cooldown_until IS NULL OR cooldown_until<=now()) ORDER BY (data->>'priority')::int,last_used NULLS FIRST,id",[actor.companyId,model])).rows;
            for(const row of rows){
                if(excluded.has(row.id)||!this.visible(actor,row.data)||(!row.credential&&!(row.data.source==='environment'&&this.fallback)))continue;
                const environmentGroup=(await client.query("SELECT 1 FROM provider_channels WHERE company_id=$1 AND data->>'source'='environment' AND data->>'provider'=$2 AND data->>'accountGroup'=$3",[actor.companyId,row.data.provider,row.data.accountGroup])).rowCount!>0;
                const group=this.accountKey(actor.companyId,row.data,environmentGroup);
                const globalLimit=environmentGroup?(await client.query("SELECT min((data->>'maxConcurrency')::int) AS n FROM provider_channels WHERE data->>'source'='environment'",[])).rows[0].n:row.data.maxConcurrency;
                const count=(await client.query('SELECT count(*)::int AS n FROM channel_leases WHERE account_group=$1',[group])).rows[0].n;if(count>=globalLimit)continue;
                const lease=randomUUID();await client.query("INSERT INTO channel_leases(id,company_id,channel_id,account_group,principal_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '120 seconds')",[lease,actor.companyId,row.id,group,actor.id]);
                await client.query('UPDATE provider_channels SET last_used=clock_timestamp() WHERE company_id=$1 AND id=$2',[actor.companyId,row.id]);await client.query('COMMIT');return {actor,row,lease};
            }
            await client.query('COMMIT');return null;
        }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    }
    async forward(principalId:string,body:any,signal:AbortSignal,beforeDispatch?:()=>Promise<unknown>){
        const actor=await this.host.db.get<Actor>('actors',principalId);await this.ensureDefault(actor.companyId);
        const deadline=Date.now()+15000,excluded=new Set<string>();const attempts:Array<{channelId:string;accountGroup:string;status:number}>=[];
        while(Date.now()<deadline&&attempts.length<3){
            signal.throwIfAborted();const admission=await this.acquire(principalId,body.model,excluded);
            if(!admission){if(excluded.size)break;await new Promise(r=>setTimeout(r,100));continue;}
            const {row,lease}=admission;let status=0,dispatched=false;
            try{
                if(beforeDispatch)await beforeDispatch();signal.throwIfAborted();
                const key=row.credential?this.decrypt(row.credential):this.fallback!.key;
                const base=row.data.baseURL.replace(/\/$/u,''),url=base+(base.endsWith('/v1')?'/messages':'/v1/messages');
                dispatched=true;const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(60000)]),headers:{'content-type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify({...body,metadata:{user_id:contentHash([actor.companyId,actor.id]).slice(0,40)}})});
                status=response.status;attempts.push({channelId:row.id,accountGroup:row.data.accountGroup,status});
                if([401,402,429].includes(status)){
                    await response.body?.cancel().catch(()=>{});excluded.add(row.id);
                    const seconds=status===401?3600:status===402?300:Math.min(300,Math.max(5,Number(response.headers.get('retry-after'))||15));
                    if(status===429)await this.host.db.pool.query("UPDATE provider_channels SET cooldown_until=now()+($4::int*interval '1 second'),last_status=$5 WHERE company_id=$1 AND data->>'provider'=$2 AND data->>'accountGroup'=$3",[actor.companyId,row.data.provider,row.data.accountGroup,seconds,status]);
                    else await this.host.db.pool.query("UPDATE provider_channels SET cooldown_until=now()+($3::int*interval '1 second'),last_status=$4 WHERE company_id=$1 AND id=$2",[actor.companyId,row.id,seconds,status]);
                    continue;
                }
                const chunks:Uint8Array[]=[];let size=0;for await(const chunk of response.body??[]){size+=chunk.length;if(size>2000000)fail('INVALID_OUTPUT','Provider response exceeded limit');chunks.push(chunk);}
                await this.host.db.pool.query('UPDATE provider_channels SET last_status=$3 WHERE company_id=$1 AND id=$2',[actor.companyId,row.id,status]);
                return {status,text:Buffer.concat(chunks).toString('utf8'),contentType:response.headers.get('content-type')??'application/json',providerRequestId:response.headers.get('request-id')??response.headers.get('x-request-id'),channelId:row.id,accountGroup:row.data.accountGroup,provider:row.data.provider,attempts};
            }catch(e){if(!dispatched)throw e;throw new FrameworkError('RESULT_UNKNOWN','Provider request has no trustworthy receipt; it was not replayed',{channelId:row.id,accountGroup:row.data.accountGroup,status});}
            finally{
                try { await this.host.db.pool.query('DELETE FROM channel_leases WHERE id=$1',[lease]);await this.host.db.audit('channel.request',{companyId:actor.companyId,principalId:actor.id,channelId:row.id,accountGroup:row.data.accountGroup,status}); }
                catch { if(dispatched&&![401,402,429].includes(status))throw new FrameworkError('RESULT_UNKNOWN','Provider response persistence needs reconciliation; the request was not replayed',{channelId:row.id,accountGroup:row.data.accountGroup,status});throw new FrameworkError('UNAVAILABLE','Channel accounting is temporarily unavailable'); }
            }
        }
        throw new FrameworkError('PROVIDER_UNAVAILABLE','Available channel capacity is exhausted; retry after the queue settles',{attempts});
    }
    registerRoutes(app:FastifyInstance){
        const principal=async(r:any)=>(await authenticateRequest(this.host,r)).id;
        app.get('/v1/admin/channels',async request=>({channels:await this.list(await principal(request),true),limits:{perEmployeeModelRequests:2,defaultHostRuns:3}}));
        app.post('/v1/admin/channels',{schema:{body:bodySchema}},async(request,reply)=>reply.code(201).send(await this.save(await principal(request),request.body as any,true)));
        app.put<{Params:{id:string}}>('/v1/admin/channels/:id',{schema:{body:bodySchema}},async request=>{if(request.params.id!==(request.body as any).id)fail('INVALID_INPUT','Channel id is fixed');return this.save(await principal(request),request.body as any,false);});
        app.get('/v1/connections',async request=>({items:(await this.list(await principal(request))).filter(c=>c.enabled).map(({source,revision,cooldownUntil,lastStatus,activeRequests,...publicData})=>publicData)}));
    }
}
