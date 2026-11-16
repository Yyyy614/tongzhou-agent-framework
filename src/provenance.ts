import{SourceCollections}from'./source-collections.js';
import {randomUUID} from 'node:crypto';
import type {Framework} from './index.js';
import type {Actor} from './types.js';
import {contentHash} from './contracts.js';
import {fail} from './errors.js';
import type{PoolClient}from'pg';
import type{FastifyInstance}from'fastify';import{authenticateRequest}from'./console-auth.js';
type Query=Pick<PoolClient,'query'>;

export interface SourceOrigin {
    kind:'resource'|'memory'|'input'|'tool'|'unknown'|'work-memory'|'source-set';
    id:string;version?:number;revision?:string;agentId?:string;ownerId?:string;companyId?:string;digest?:string;readerIds?:string[];
    /** Host-generated revision ancestry; never accepted from tools or client declarations. */
    relation?:'revision-history';
}
/** Immutable input origins are recorded by host adapters, never accepted from a model report. */
export class SourceProvenance {
    readonly collections:SourceCollections;constructor(readonly host:Framework){this.collections=new SourceCollections(host);}
    async open(){await this.collections.open();await this.host.db.pool.query(`
      CREATE TABLE IF NOT EXISTS execution_sources(run_id text PRIMARY KEY,company_id text NOT NULL,principal_id text NOT NULL,agent_id text NOT NULL,sources jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS model_context_requests(id uuid PRIMARY KEY,run_id text NOT NULL,principal_id text NOT NULL,agent_id text NOT NULL,ordinal integer NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(run_id,ordinal));
      CREATE TABLE IF NOT EXISTS execution_reports(run_id text PRIMARY KEY,report_hash text NOT NULL,sources jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_work_revisions(run_id text NOT NULL,work_id uuid NOT NULL,agent_id text NOT NULL,owner_id text NOT NULL,revision integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(run_id,work_id,agent_id,owner_id,revision));
    `);}
    unique(sources:SourceOrigin[]){return [...new Map(sources.map(s=>[contentHash(s),s])).values()];}
    async add(runId:string,principalId:string,agentId:string,sources:SourceOrigin[]){
        const {actor}=await this.host.authorize(principalId,agentId);
        const client=await this.host.db.pool.connect();
        try{await client.query('BEGIN');await client.query('INSERT INTO execution_sources(run_id,company_id,principal_id,agent_id,sources) VALUES($1,$2,$3,$4,\'[]\') ON CONFLICT DO NOTHING',[runId,actor.companyId,actor.id,agentId]);
            const row=(await client.query('SELECT * FROM execution_sources WHERE run_id=$1 FOR UPDATE',[runId])).rows[0];
            if(row.principal_id!==actor.id||row.agent_id!==agentId)fail('PERMISSION_DENIED','Execution source scope changed');
            const next=this.unique([...row.sources,...sources]);if(next.length>512)fail('CONTEXT_BUDGET_EXCEEDED','Execution source expansion limit reached');
            await client.query('UPDATE execution_sources SET sources=$2,updated_at=now() WHERE run_id=$1',[runId,JSON.stringify(next)]);await client.query('COMMIT');
        }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }
    async snapshot(runId:string,client:Query=this.host.db.pool){
        const row=(await client.query('SELECT sources FROM execution_sources WHERE run_id=$1',[runId])).rows[0];if(!row)return undefined;
        const revisions=(await client.query('SELECT work_id,agent_id,owner_id,max(revision)::integer AS revision FROM execution_work_revisions WHERE run_id=$1 GROUP BY work_id,agent_id,owner_id',[runId])).rows;
        return(row.sources as SourceOrigin[]).map(source=>source.kind==='work-memory'&&revisions.some(r=>r.work_id===source.id&&r.agent_id===source.agentId&&r.owner_id===source.ownerId&&source.version!<r.revision)?{...source,relation:'revision-history' as const}:source);
    }
    async acceptWorkRevision(runId:string,principalId:string,agentId:string,workId:string,revision:number){
        const client=await this.host.db.pool.connect();try{await client.query('BEGIN');await this.host.organization.lock(client);const{actor,agent}=await this.host.authorize(principalId,agentId,'execute',client);
            const note=(await client.query('SELECT * FROM work_memory_versions WHERE work_id=$1 AND agent_id=$2 AND principal_id=$3 AND revision=$4',[workId,agentId,actor.id,revision])).rows[0];
            if(!note||agent.ownerId!==actor.id||note.written_by_run!==runId)fail('CONFLICT','Only this run\'s confirmed note revision can refresh its context');
            const ledger=(await client.query('SELECT * FROM execution_sources WHERE run_id=$1 FOR UPDATE',[runId])).rows[0];if(!ledger||ledger.principal_id!==actor.id||ledger.agent_id!==agentId)fail('PERMISSION_DENIED','Run source scope unavailable');
            const next=this.unique([...ledger.sources,{kind:'work-memory',id:workId,agentId,ownerId:actor.id,version:revision},...note.dependencies]);if(next.length>512)fail('CONTEXT_BUDGET_EXCEEDED','Run source expansion limit reached');
            await client.query('UPDATE execution_sources SET sources=$2,updated_at=now() WHERE run_id=$1',[runId,JSON.stringify(next)]);
            await client.query('INSERT INTO execution_work_revisions(run_id,work_id,agent_id,owner_id,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[runId,workId,agentId,actor.id,revision]);await client.query('COMMIT');
        }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }
    async sealReport(runId:string,report:unknown){const sources=await this.snapshot(runId);await this.host.db.pool.query('INSERT INTO execution_reports(run_id,report_hash,sources) VALUES($1,$2,$3) ON CONFLICT(run_id) DO UPDATE SET report_hash=EXCLUDED.report_hash,sources=EXCLUDED.sources',[runId,contentHash(report),JSON.stringify(sources?.length?sources:[{kind:'unknown',id:runId}])]);}
    async reportSources(runId:string,report:unknown,client:Query=this.host.db.pool):Promise<SourceOrigin[]|undefined>{const row=(await client.query('SELECT * FROM execution_reports WHERE run_id=$1',[runId])).rows[0];return row&&row.report_hash===contentHash(report)?row.sources:undefined;}
    async resultAccess(principalId:string,sources:SourceOrigin[]|null|undefined,client:Query=this.host.db.pool){
        if(!sources?.length||sources.some(s=>s.kind==='unknown'))return{visible:false,current:false,fingerprint:null,visibility:'unknown',validity:'unknown',notice:'来源账本缺失，派生正文受限；执行记录和控制状态保留。'};
        const status=await this.status(principalId,sources,client);
        if(status.verified===false)return{...status,visible:false,current:false,visibility:'unknown',validity:'unknown',notice:'来源集合尚未核实，派生正文受限；历史与控制记录保留。'};
        return{...status,visibility:status.visible?'authorized':'restricted',validity:!status.visible?'restricted':status.current?'current':'source-changed',notice:!status.visible?'部分来源当前不可读取，派生正文受限。':status.current?'按当前来源权限可读；结论仍需核实。':'历史来源已被替代或失效；可查历史，不作为当前结论。'};
    }
    async resultForRun(principalId:string,runId:string|undefined,retainedSources:SourceOrigin[]|null|undefined,client:Query=this.host.db.pool){
        const ledger=runId?await this.snapshot(runId,client):undefined;
        const sources=retainedSources?.length&&ledger?.length&&!ledger.some(s=>s.kind==='unknown')?this.unique([...retainedSources,...ledger]):null;
        return this.resultAccess(principalId,sources,client);
    }
    async input(runId:string,actor:Actor,agentId:string,input:string,client:Query=this.host.db.pool):Promise<SourceOrigin>{
        const task=(await client.query("SELECT t.principal_id FROM runs r JOIN tasks t ON t.id::text=r.data->>'taskId' WHERE r.id=$1 AND r.principal_id=$2 AND t.data->>'executionPrincipalId'=$2 AND t.agent_id=$3",[runId,actor.id,agentId])).rows[0];
        return{kind:'input',id:runId,ownerId:actor.id,companyId:actor.companyId,agentId,readerIds:task?[task.principal_id]:[],digest:contentHash(input)};
    }
    async resourceOrigins(value:any,client:Query=this.host.db.pool):Promise<SourceOrigin[]>{
        const version=(await client.query('SELECT dependencies,source_refs,created_by FROM resource_versions WHERE resource_id=$1 AND version=$2',[value.id,value.version])).rows[0];
        if(!version)fail('NOT_FOUND','Resource origin is unavailable');
        const inherited=version.dependencies??(version.source_refs.some((s:string)=>/^(?:run|task):/u.test(s))?[{kind:'unknown',id:value.id,ownerId:version.created_by}]:[]);
        return [{kind:'resource',id:value.id,version:value.version,revision:value.revision},...inherited];
    }
    async status(principalId:string,sources:SourceOrigin[]|null|undefined,client:Query=this.host.db.pool,path:Set<string>=new Set()):Promise<{visible:boolean;current:boolean;fingerprint:string|null;verified?:boolean}>{
        if(!sources)return{visible:false,current:false,fingerprint:null};
        const actor=await this.host.db.get<Actor>('actors',principalId,client);if(!actor.active)return{visible:false,current:false,fingerprint:null};
        let current=true,verified=true;const stamps:unknown[]=[];
        for(const source of sources){
            if(source.kind==='unknown'){verified=false;current=false;}
            if(source.kind==='source-set'){try{const resolved=await this.collections.resolve(source,client);if(resolved.row.company_id!==actor.companyId)return{visible:false,current:false,fingerprint:null,verified:false};const nested=await this.status(actor.id,resolved.sources,client,path);if(!nested.visible)return nested;current&&=nested.current;verified&&=nested.verified!==false;stamps.push([source.id,resolved.row.digest,nested.fingerprint]);}catch(error){if(!['NOT_FOUND','CONTEXT_BUDGET_EXCEEDED'].includes((error as any).code))throw error;return{visible:false,current:false,fingerprint:null,verified:false};}}else if(source.kind==='resource'){
                const status=await this.host.resources.originStatus(actor.id,source,client);
                if(!status.visible)return{visible:false,current:false,fingerprint:null};current&&=status.current;stamps.push([source.id,status.revision,status.current]);
            }else if(source.kind==='memory'){
                try{const scope=await this.host.authorizeMemory(actor.id,source.agentId!,'read',client),note=(await client.query('SELECT version FROM memories WHERE agent_id=$1 AND note_id=$2',[source.agentId,source.id])).rows[0],version=(await client.query('SELECT principal_id,dependencies FROM memory_versions WHERE agent_id=$1 AND note_id=$2 AND version=$3',[source.agentId,source.id,source.version])).rows[0];if(!note||!version||version.principal_id!==scope.agent.ownerId||source.ownerId&&source.ownerId!==version.principal_id)return{visible:false,current:false,fingerprint:null};const key=source.agentId+':'+source.id+':'+source.version;if(path.has(key)||path.size>64)return{visible:false,current:false,fingerprint:null};const nested=await this.status(actor.id,version.dependencies,client,new Set([...path,key]));if(!nested.visible)return{visible:false,current:false,fingerprint:null};verified&&=nested.verified!==false;current&&=note.version===source.version&&nested.current;stamps.push([source.agentId,source.id,note.version,nested.fingerprint,nested.current,contentHash(scope.actor),contentHash(scope.agent)]);}
                catch(error){if(['PERMISSION_DENIED','NOT_FOUND'].includes((error as any).code))return{visible:false,current:false,fingerprint:null};throw error;}
            }else if(source.kind==='work-memory'){
                const key='work:'+source.agentId+':'+source.id+':'+source.version;if(path.has(key)||path.size>=64)return{visible:false,current:false,fingerprint:null};
                const status=await this.host.workMemory.originStatus(actor.id,source,client);if(!status.visible)return{visible:false,current:false,fingerprint:null};
                const nested=await this.status(actor.id,status.dependencies,client,new Set([...path,key]));if(!nested.visible)return{visible:false,current:false,fingerprint:null};
                verified&&=nested.verified!==false;current&&=(source.relation==='revision-history'||status.current===true)&&nested.current;stamps.push([source.id,source.agentId,status.authority,nested.fingerprint,source.relation??'current']);
            }else if(source.companyId&&source.companyId!==actor.companyId)return{visible:false,current:false,fingerprint:null};
            else if(source.ownerId!==actor.id){
                if(!source.readerIds?.includes(actor.id)||!source.agentId)return{visible:false,current:false,fingerprint:null};
                try{await this.host.organization.authorizeAgent(actor.id,source.agentId,'read',client);}catch(error){if((error as any).code==='PERMISSION_DENIED')return{visible:false,current:false,fingerprint:null};throw error;}
            }
        }
        return{visible:true,current,fingerprint:contentHash(stamps),verified};
    }
    async request(runId:string,principalId:string,agentId:string,ordinal:number,body:unknown,manifest:any){
        const sources=await this.snapshot(runId);if(!sources)fail('CONFLICT','Model request has no host source ledger');
        const status=await this.status(principalId,sources);if(!status.visible)fail('CONFLICT','Model source access changed before dispatch');
        const id=randomUUID(),data={...manifest,requestId:id,sources,requestHash:contentHash(body),requestChars:JSON.stringify(body).length,policy:'all-input-origins-v1'};
        const inserted=(await this.host.db.pool.query('INSERT INTO model_context_requests(id,run_id,principal_id,agent_id,ordinal,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id,ordinal) DO NOTHING RETURNING id',[id,runId,principalId,agentId,ordinal,JSON.stringify(data)])).rows[0];
        if(inserted)return inserted.id as string;
        const previous=(await this.host.db.pool.query('SELECT id,principal_id,agent_id,data FROM model_context_requests WHERE run_id=$1 AND ordinal=$2',[runId,ordinal])).rows[0];
        if(!previous||previous.principal_id!==principalId||previous.agent_id!==agentId||contentHash(previous.data)!==contentHash({...data,requestId:previous.id}))fail('CONFLICT','A model request ordinal cannot replace its attested input');
        return previous.id as string;
    }
    async inspect(principalId:string,id:string){
        const row=(await this.host.db.pool.query('SELECT * FROM model_context_requests WHERE id=$1',[id])).rows[0];if(!row)fail('NOT_FOUND','Context record unavailable');const{actor}=await this.host.authorize(principalId,row.agent_id,'read');const data=row.data,status=await this.status(actor.id,data.sources),sources:any[]=[],seen=new Set<string>();
        for(const origin of data.sources as SourceOrigin[]){const key=origin.kind+':'+origin.id+'@'+origin.version;if(seen.has(key))continue;seen.add(key);try{if(origin.kind==='resource'){const value=await this.host.resources.read(actor.id,origin.id,origin.version,0,1);sources.push({kind:'resource',name:value.title,ref:value.resourceRef,domain:value.domain,validity:value.derivedValidity==='current'?value.freshness:value.derivedValidity,continuation:'/v1/resources/'+value.id+'?version='+value.version});}else if(origin.kind==='source-set'){if((await this.status(actor.id,[origin])).visible)sources.push({kind:'source-set',name:'版本化来源集合',version:origin.version,continuation:'/v1/source-sets/'+origin.id});}else if(origin.kind==='memory'){const value=await this.host.readMemory({principalId:actor.id,agentId:origin.agentId!,noteId:origin.id});sources.push({kind:'memory',name:'岗位记忆 · '+value.noteId,version:origin.version});}else if(origin.kind==='work-memory'){const value=await this.host.workMemory.read(actor.id,origin.id,origin.agentId!);if(value.visibility==='private-work-memory')sources.push({kind:'work-memory',name:'当前工作笔记',version:origin.version});}else if((await this.status(actor.id,[origin])).visible)sources.push({kind:origin.kind,name:origin.kind==='input'?'本轮输入':'宿主记录的工具返回',version:origin.version});}catch(e){if(!['NOT_FOUND','PERMISSION_DENIED','CONFLICT'].includes((e as any).code))throw e;}}
        const pack=(await this.host.db.pool.query('SELECT invalidated_at,invalidated_reason FROM context_packs WHERE id=$1',[data.contextPackId])).rows[0];let work:any;if(data.workId){try{const current=await this.host.coordination?.get(actor.id,data.workId);if(current)work={id:current.id,title:current.title,state:current.state,controlMode:current.controlMode};}catch(e){if(!['PERMISSION_DENIED','NOT_FOUND'].includes((e as any).code))throw e;}}
        const own=row.principal_id===actor.id,coverage=status.visible?data.recall?.coverage??{status:'not-requested'}:{status:'restricted',notice:'部分上下文受来源权限保护，未展示私人内容。'};
        return{id:row.id,runId:row.run_id,agentId:row.agent_id,ordinal:row.ordinal,createdAt:row.created_at,sourceVisibility:status.verified===false?'unknown':status.visible?'authorized':'restricted',validity:status.verified===false?'unverified':pack?.invalidated_at||status.visible&&!status.current?'source-changed':status.visible?'current':'restricted',invalidationReason:pack?.invalidated_reason??null,sources,work,coverage,budget:data.budget??{},...(status.visible?{selection:data.recall?.selection,omissions:data.recall?.coverage?.omissions??[],workMemoryOmissions:own?data.workMemoryOmissions??[]:[]}:{}),requestHash:own?data.requestHash:undefined,requestChars:data.requestChars,answerBasis:'依据本轮输入、宿主工作状态及实际读取的资料生成；模型报告不改变执行或审批事实。',notice:'来源清单解释输入依据，不代表模型结论已经人工核实。'};
    }
    async latest(principalId:string,agentId:string){await this.host.authorize(principalId,agentId,'read');const row=(await this.host.db.pool.query('SELECT id FROM model_context_requests WHERE agent_id=$1 ORDER BY created_at DESC,ordinal DESC LIMIT 1',[agentId])).rows[0];return row?this.inspect(principalId,row.id):{empty:true,sources:[],notice:'该岗位尚无模型上下文记录。'};}
    registerRoutes(app:FastifyInstance){app.get<{Params:{id:string};Querystring:{cursor?:string;limit?:number}}>('/v1/source-sets/:id',{schema:{querystring:{type:'object',additionalProperties:false,properties:{cursor:{type:'string',format:'uuid'},limit:{type:'integer',minimum:1,maximum:100}}}}},async req=>this.collections.page((await authenticateRequest(this.host,req)).id,req.params.id,req.query));const actor=async(req:any)=>(await authenticateRequest(this.host,req)).id;app.get<{Params:{agentId:string}}>('/v1/agents/:agentId/context-latest',async req=>this.latest(await actor(req),req.params.agentId));app.get<{Params:{id:string}}>('/v1/model-contexts/:id',async req=>this.inspect(await actor(req),req.params.id));app.get<{Params:{agentId:string}}>('/v1/agents/:agentId/context-history',async req=>{await this.host.authorize(await actor(req),req.params.agentId,'read');const rows=(await this.host.db.pool.query('SELECT id,run_id AS "runId",ordinal,created_at AS "createdAt" FROM model_context_requests WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 30',[req.params.agentId])).rows;return{items:rows};});}
}
