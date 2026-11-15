import{randomUUID}from'node:crypto';
import{createRequire}from'node:module';
import type{EntryConnections}from'./entry-connections.js';
import{fail}from'./errors.js';
import{requireUuid}from'./contracts.js';
/** Official WeCom CLI protocol, with a separate product source and five-minute ownership. */
export class EntryQr{
    constructor(readonly entries:EntryConnections){}
    private async request(url:string){try{const response=await(this.entries.host.options.entryQrFetch??fetch)(url,{signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok)fail('PROVIDER_UNAVAILABLE','QR provider is unavailable');return await response.json() as any;}catch{fail('PROVIDER_UNAVAILABLE','QR provider did not return a valid response');}}
    private async image(url:string){const require=createRequire(new URL('../connectors/im-bridge/package.json',import.meta.url));return require('qrcode').toDataURL(url,{errorCorrectionLevel:'M',width:280,margin:3});}
    async create(principalId:string,name:string){
        const e=this.entries;await e.ready;const actor=await e.actor(principalId,true);if(!name?.trim()||name.length>80)fail('INVALID_INPUT','A connection name is required');
        const active=(await e.host.db.pool.query('SELECT id FROM entry_qr WHERE principal_id=$1 AND expires_at>now()',[actor.id])).rowCount??0;
        if(active>=5)fail('BUDGET_EXCEEDED','Too many active QR sessions; use an existing code');
        const result=await this.request('https://work.weixin.qq.com/ai/qc/generate?source=company_agent_framework&plat=3'),data=result?.data;
        if(typeof data?.scode!=='string'||data.scode.length>4096||typeof data.auth_url!=='string'||data.auth_url.length>8000)fail('PROVIDER_UNAVAILABLE','QR provider response is incomplete');
        const url=new URL(data.auth_url);if(url.protocol!=='https:'||!(url.hostname==='weixin.qq.com'||url.hostname.endsWith('.weixin.qq.com'))||url.username||url.password)fail('PROVIDER_UNAVAILABLE','Unexpected QR authorization destination');
        const id=randomUUID(),expiresAt=new Date(Date.now()+300000);await e.host.db.pool.query('INSERT INTO entry_qr(id,company_id,principal_id,state,data,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[id,actor.companyId,actor.id,'pending',await e.vault.seal({scode:data.scode,authUrl:data.auth_url,name:name.trim()},'qr:'+actor.companyId+':'+id),expiresAt]);
        return{id,state:'pending',qrImage:await this.image(data.auth_url),expiresAt};
    }
    async poll(principalId:string,id:string){
        requireUuid(id);const e=this.entries,actor=await e.actor(principalId,true),row=(await e.host.db.pool.query('SELECT * FROM entry_qr WHERE id=$1',[id])).rows[0];if(!row||row.principal_id!==actor.id||row.company_id!==actor.companyId)fail('PERMISSION_DENIED','QR session belongs to another account');
        if(row.state==='connected')return{id,state:row.state,connectionId:row.connection_id};
        if(row.expires_at.getTime()<=Date.now()){await e.host.db.pool.query("UPDATE entry_qr SET state='expired' WHERE id=$1",[id]);return{id,state:'expired'};}
        const acquired=await e.host.db.pool.query("UPDATE entry_qr SET next_poll_at=now()+interval '3 seconds' WHERE id=$1 AND state='pending' AND next_poll_at<=now() RETURNING id",[id]);if(!acquired.rowCount)return{id,state:row.state};
        const privateData=await e.vault.open(row.data,'qr:'+actor.companyId+':'+id),result=await this.request('https://work.weixin.qq.com/ai/qc/query_result?scode='+encodeURIComponent(privateData.scode));
        if(result?.data?.status!=='success')return{id,state:'pending'};
        const bot=result.data.bot_info;if(typeof bot?.botid!=='string'||typeof bot.secret!=='string')fail('PROVIDER_UNAVAILABLE','Authorized QR response omitted robot credentials');
        // Recheck ownership/expiry after network IO; never silently replace another connection.
        await e.actor(principalId,true);if(row.expires_at.getTime()<=Date.now())return{id,state:'expired'};
        const connection=await e.create(actor.id,{name:privateData.name,provider:'wecom',credentials:{botId:bot.botid,secret:bot.secret}},id);
        await e.host.db.pool.query("UPDATE entry_qr SET state='connected',connection_id=$2 WHERE id=$1 AND state='pending'",[id,connection.id]);return{id,state:'connected',connectionId:connection.id};
    }
}

