import{test,expect}from'vitest';
import{mkdir,mkdtemp}from'node:fs/promises';
import{resolve}from'node:path';
import{randomUUID}from'node:crypto';
import{createFramework}from'../src/index.js';
import{createServer}from'../src/server.js';
import{TaskQueue}from'../src/tasks.js';
import{normalize}from'../connectors/im-bridge/transports.mjs';

async function fixture(extra:any={}){
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data/entries-'));let calls=0;const sent:string[]=[];
    const host=await createFramework({root,entries:true,entryTransportFactory:async()=>({send:async(_reply:any,text:string)=>{sent.push(text);},close:async()=>{}}),...extra} as any),app=await createServer(host),queue=new TaskQueue(host,{async run(){calls++;return{id:randomUUID(),state:'succeeded',output:'private process text',report:{facts:[{text:'confirmed generic result',refs:[]}],artifacts:[],issues:[]}};}});
    await host.installPlugin(resolve('fixtures/conformance-plugin'));await host.putActor({id:'admin',companyId:'one',role:'admin',permissions:[]});await host.putActor({id:'alice',companyId:'one',role:'employee',permissions:[]});await host.putActor({id:'outsider',companyId:'two',role:'admin',permissions:[]});
    await host.putAgent({id:'alice-agent',companyId:'one',ownerId:'alice',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});
    await queue.open();queue.registerRoutes(app);const headers:any={};for(const id of ['admin','alice','outsider'])headers[id]={authorization:'Bearer '+await host.issueAccessToken(id)};
    const api=async(path:string,method='GET',body?:any,actor='admin')=>app.inject({url:path,method:method as any,headers:headers[actor],payload:body});
    const create=async()=>{const response=await api('/v1/admin/entries','POST',{name:'DingTalk test',provider:'dingtalk',credentials:{clientId:'fixture-app',clientSecret:'fixture-secret-do-not-return'}});expect(response.statusCode).toBe(201);return response.json();};
    const pair=async(id:string)=>{const pairing=(await api('/v1/entries/bind','POST',{connectionId:id,agentId:'alice-agent'},'alice')).json();await host.entries!.accept(id,message('bind','/bind '+pairing.code));const current=(await api('/v1/entries/bind/'+pairing.id,'GET',undefined,'alice')).json();const result=await api('/v1/entries/bind/'+pairing.id+'/confirm','POST',{revision:current.revision},'alice');expect(result.statusCode).toBe(200);return result.json().bindingId;};
    return{host,app,queue,api,create,pair,sent,calls:()=>calls,close:async()=>{await host.entries?.close();await queue.close();await app.close();await host.close();}};
}
const message=(id:string,text:string)=>({externalUserId:'corp:external-alice',conversationId:'private-alice',messageId:id,text,isGroup:false,reply:{target:'fixture'}});

test.each(['dingtalk','feishu','wecom'])('%s simulated configuration, identity binding and Work control complete the same account-scoped flow',async provider=>{
    const credentials=provider==='dingtalk'?{clientId:'fixture-app',clientSecret:'simulated-secret'}:provider==='feishu'?{appId:'fixture-app',appSecret:'simulated-secret'}:{botId:'fixture-app',secret:'simulated-secret'};
    let receive!:(event:any)=>Promise<any>;
    const sent:string[]=[];const f=await fixture({entryTransportFactory:async(actual:string,configured:any,hooks:any)=>{expect(actual).toBe(provider);expect(configured).toEqual(credentials);receive=hooks.receive;hooks.health('connected');return{send:async(_reply:any,text:string)=>{sent.push(text);},close:async()=>{}};}});
    const incoming=async(id:string,text:string)=>{
        const frame=provider==='dingtalk'?{headers:{messageId:id},data:JSON.stringify({msgtype:'text',msgId:id,senderCorpId:'corp',senderStaffId:'alice',senderNick:'admin',conversationId:'private',conversationType:'1',text:{content:text},sessionWebhook:'https://oapi.dingtalk.com/robot/sendBySession?session=fixture',sessionWebhookExpiredTime:Date.now()+60000})}:provider==='feishu'?{sender:{sender_type:'user',tenant_key:'corp',sender_id:{open_id:'alice'}},message:{message_id:id,chat_id:'private',chat_type:'p2p',message_type:'text',content:JSON.stringify({text})}}:{headers:{req_id:id},body:{msgid:id,msgtype:'text',chattype:'single',from:{userid:'alice'},text:{content:text}}};
        return receive(normalize(provider,frame));
    };
    try{
        expect((await f.api('/v1/admin/entries','POST',{name:'Invalid simulated app',provider,credentials:{clientId:'wrong-fields'}})).statusCode).toBe(400);
        const created=await f.api('/v1/admin/entries','POST',{name:'Simulated '+provider,provider,credentials});expect(created.statusCode).toBe(201);expect(created.body).not.toContain('simulated-secret');const connection=created.json();
        await f.host.entries!.start();await f.queue.startWorker();expect((await incoming('unbound','not yet authorized')).accepted).toBe(false);
        const pairing=(await f.api('/v1/entries/bind','POST',{connectionId:connection.id,agentId:'alice-agent'},'alice')).json();await incoming('bind','/bind '+pairing.code);
        const candidate=(await f.api('/v1/entries/bind/'+pairing.id,'GET',undefined,'alice')).json();expect(candidate.state).toBe('claimed');
        expect((await f.api('/v1/entries/bind/'+pairing.id+'/confirm','POST',{revision:candidate.revision},'outsider')).statusCode).toBe(403);
        expect((await f.api('/v1/entries/bind/'+pairing.id+'/confirm','POST',{revision:candidate.revision},'alice')).statusCode).toBe(200);
        const accepted=await incoming('task','complete one generic check');expect((await incoming('task','complete one generic check')).duplicate).toBe(true);
        await expect.poll(()=>sent.length,{timeout:10000}).toBe(1);expect(f.calls()).toBe(1);expect(sent[0]).toContain('confirmed generic result');const reference=sent[0]!.match(/W-\d+/u)![0];
        const workId=(await f.host.db.pool.query('SELECT work_id FROM entry_events WHERE id=$1',[accepted.id])).rows[0].work_id;
        await incoming('status','/status');await expect.poll(()=>sent.length,{timeout:5000}).toBe(2);expect(sent[1]).toContain(reference);
        await incoming('wait','/wait '+reference+' 等待负责人确认');await expect.poll(()=>sent.length,{timeout:5000}).toBe(3);expect((await f.api('/v1/work/'+workId,'GET',undefined,'alice')).json().state).toBe('waiting');
        await incoming('resume','/resume '+reference+' 明确批准执行新的通用检查');await expect.poll(()=>sent.length,{timeout:10000}).toBe(4);expect(f.calls()).toBe(2);
        await incoming('stop','/stop '+reference+' 停止后续工作');await expect.poll(()=>sent.length,{timeout:5000}).toBe(5);expect((await f.api('/v1/work/'+workId,'GET',undefined,'alice')).json().state).toBe('stopped');
        const history=(await f.api('/v1/work/'+workId+'/history','GET',undefined,'alice')).json();expect(history.rounds).toHaveLength(2);expect(history.rounds[0].assignments[0].state).toBe('succeeded');
        const binding=(await f.api('/v1/entries/mine','GET',undefined,'alice')).json().bindings[0];await f.api('/v1/entries/bindings/'+binding.id+'/revoke','POST',{},'alice');expect((await incoming('revoked','must not create work')).accepted).toBe(false);expect((await f.host.db.pool.query('SELECT id FROM work_items')).rowCount).toBe(1);
        expect((await f.api('/v1/admin/entries')).body).not.toContain('simulated-secret');
    }finally{await f.close();}
},30000);

test('an unknown committed result cannot be downgraded by a later transient authorization read',async()=>{
    const f=await fixture();try{
        const connection=await f.create();await f.pair(connection.id);
        const work=f.host.coordination!,create=work.create.bind(work);work.create=async(...args:any[])=>{await(create as any)(...args);throw Error('post-commit result read failed');};
        const entries=f.host.entries!,active=entries.activeBinding.bind(entries);let injected=false;
        entries.activeBinding=async(event:any)=>{if(!injected&&event.state==='error_ready'){injected=true;throw Error('one transient authorization read failure');}return active(event);};
        await entries.start();const accepted=await entries.accept(connection.id,message('unknown-without-id','Complete only once'));
        await expect.poll(()=>f.sent.length,{timeout:10000}).toBe(1);expect(injected).toBe(true);expect(f.sent[0]).toContain('结果待核实');
        const event=(await f.host.db.pool.query('SELECT state,data FROM entry_events WHERE id=$1',[accepted.id])).rows[0];expect(event.state).toBe('result_unconfirmed');expect(event.data.error.resultUnconfirmed).toBe(true);expect((await f.host.db.pool.query('SELECT id FROM work_items')).rowCount).toBe(1);
    }finally{await f.close();}
},30000);

test('a failure after work creation reports an unconfirmed result instead of claiming no execution',async()=>{
    const f=await fixture();try{
        const connection=await f.create();await f.pair(connection.id);
        const original=f.host.db.pool.query.bind(f.host.db.pool);let injected=false;
        (f.host.db.pool as any).query=(sql:any,...args:any[])=>{
            if(!injected&&typeof sql==='string'&&sql.startsWith("UPDATE entry_events SET state='waiting',work_id=")){injected=true;return Promise.reject(Error('simulated connection loss after work commit'));}
            return(original as any)(sql,...args);
        };
        await f.host.entries!.start();await f.queue.startWorker();
        const accepted=await f.host.entries!.accept(connection.id,message('committed-then-failure','Complete this generic check'));
        await expect.poll(()=>f.sent.length,{timeout:10000}).toBe(1);
        expect(injected).toBe(true);expect(f.sent[0]).toContain('结果待核实');expect(f.sent[0]).not.toContain('操作未执行');
        expect((await f.host.db.pool.query('SELECT id FROM work_items')).rowCount).toBe(1);
        const event=(await f.host.db.pool.query('SELECT state,work_id FROM entry_events WHERE id=$1',[accepted.id])).rows[0];expect(event.state).toBe('result_unconfirmed');expect(event.work_id).toBeTruthy();
        await f.host.entries!.accept(connection.id,message('committed-then-failure','Complete this generic check'));
        await new Promise(r=>setTimeout(r,700));expect((await f.host.db.pool.query('SELECT id FROM work_items')).rowCount).toBe(1);expect(f.sent).toHaveLength(1);
    }finally{await f.close();}
},30000);

test('external identity requires company-account confirmation and duplicate events create one managed Work',async()=>{
    const f=await fixture();try{
        const connection=await f.create();expect(JSON.stringify(connection)).not.toContain('fixture-secret');
        expect((await f.api('/v1/admin/entries')).body).not.toContain('fixture-secret');
        expect((await f.api('/v1/admin/entries','GET',undefined,'alice')).statusCode).toBe(403);
        const pairing=await f.api('/v1/entries/bind','POST',{connectionId:connection.id,agentId:'alice-agent'},'alice');expect(pairing.statusCode).toBe(201);
        await f.host.entries!.accept(connection.id,message('bind','/bind '+pairing.json().code));
        expect((await f.host.entries!.accept(connection.id,message('before-confirm','not authorized yet'))).accepted).toBe(false);
        const pending=(await f.api('/v1/entries/bind/'+pairing.json().id,'GET',undefined,'alice')).json();expect(pending.state).toBe('claimed');
        expect((await f.api('/v1/entries/bind/'+pending.id+'/confirm','POST',{revision:pending.revision},'outsider')).statusCode).toBe(403);
        expect((await f.api('/v1/entries/bind/'+pending.id+'/confirm','POST',{revision:pending.revision},'alice')).statusCode).toBe(200);
        await f.host.entries!.start();await f.queue.startWorker();
        const first=await f.host.entries!.accept(connection.id,message('one','Complete only this generic check'));const duplicate=await f.host.entries!.accept(connection.id,message('one','Complete only this generic check'));expect(first.id).toBe(duplicate.id);
        await expect.poll(()=>f.sent.length,{timeout:10000}).toBe(1);expect(f.calls()).toBe(1);
        expect((await f.host.db.pool.query('SELECT id FROM work_items')).rowCount).toBe(1);
        expect(f.sent[0]).toContain('confirmed generic result');
    }finally{await f.close();}
},30000);

test('eight waiting jobs cannot starve a newly received stop command',async()=>{
    const f=await fixture();try{const connection=await f.create();await f.pair(connection.id);await f.host.entries!.start();for(let i=0;i<8;i++)await f.host.entries!.accept(connection.id,message('long-'+i,'long task '+i));await expect.poll(async()=>(await f.host.db.pool.query('SELECT id FROM work_items')).rowCount,{timeout:10000}).toBe(8);await f.host.entries!.accept(connection.id,message('list-current','/status'));await expect.poll(()=>f.sent.length,{timeout:4000}).toBe(1);expect(f.sent[0]).toContain('最近工作');const reference=/^W-\d+/mu.exec(f.sent[0]!)![0],id=await f.host.entries!.resolveWork('one',reference);await f.host.entries!.accept(connection.id,message('priority-stop','/stop '+reference+' explicit stop'));await expect.poll(async()=>(await f.host.coordination!.get('alice',id)).state,{timeout:4000}).toBe('stopped');expect(f.calls()).toBe(0);}finally{await f.close();}
},20000);

test('malformed control commands return a clear rejection instead of creating paid model work',async()=>{
    const f=await fixture();try{const connection=await f.create();await f.pair(connection.id);await f.host.entries!.start();await f.queue.startWorker();await f.host.entries!.accept(connection.id,message('bad-stop','/stop abc'));await expect.poll(()=>f.sent.length,{timeout:8000}).toBe(1);expect(f.calls()).toBe(0);expect(f.sent[0]).toContain('命令');expect((await f.host.entries!.events('alice'))[0].state).toBe('rejected');}finally{await f.close();}
},20000);

test('revoking an external binding fences queued messages before any model work is created',async()=>{
    const f=await fixture();try{const connection=await f.create(),bindingId=await f.pair(connection.id);await f.host.entries!.accept(connection.id,message('queued','must not start'));expect((await f.api('/v1/entries/bindings/'+bindingId+'/revoke','POST',{},'alice')).statusCode).toBe(200);await f.host.entries!.start();await f.queue.startWorker();await expect.poll(async()=>(await f.host.entries!.events('alice'))[0]?.state,{timeout:8000}).toBe('blocked');expect(f.calls()).toBe(0);expect((await f.host.db.pool.query('SELECT id FROM work_items')).rowCount).toBe(0);}finally{await f.close();}
},20000);

test('group replies contain status only and uncertain outbound replies are not replayed after restart',async()=>{
    let attempts=0;const f=await fixture({entryTransportFactory:async()=>({send:async(_reply:any,text:string)=>{attempts++;expect(text).not.toContain('confirmed generic result');throw Error('response lost after send');},close:async()=>{}})});
    try{const connection=await f.create();await f.pair(connection.id);await f.host.entries!.start();await f.queue.startWorker();await f.host.entries!.accept(connection.id,{...message('group','generic request'),isGroup:true});await expect.poll(async()=>(await f.host.entries!.events('alice'))[0]?.state,{timeout:10000}).toBe('reply_unknown');await f.host.entries!.close();await f.host.entries!.start();await new Promise(r=>setTimeout(r,500));expect(attempts).toBe(1);expect(f.calls()).toBe(1);}finally{await f.close();}
},20000);

test('an expired authorization QR cannot exchange credentials or create a connection',async()=>{
    let query=0;const f=await fixture({entryQrFetch:async(url:any)=>{if(String(url).includes('query_result'))query++;return new Response(JSON.stringify({data:{scode:'fixture',auth_url:'https://work.weixin.qq.com/ai/qc/fixture'}}));}});
    try{const qr=(await f.api('/v1/admin/entries/qr','POST',{name:'Expiry test'})).json();await f.host.db.pool.query("UPDATE entry_qr SET expires_at=now()-interval '1 second' WHERE id=$1",[qr.id]);expect((await f.api('/v1/admin/entries/qr/'+qr.id)).json().state).toBe('expired');expect(query).toBe(0);expect((await f.api('/v1/admin/entries')).json()).toHaveLength(0);}finally{await f.close();}
},20000);

test('application secrets can be corrected without exposing them or replaying queued work under a changed connection',async()=>{
    const f=await fixture();try{const connection=await f.create();
        const changed=await f.api('/v1/admin/entries/'+connection.id,'PUT',{name:'Corrected connection',revision:connection.revision,credentials:{clientId:'fixture-app',clientSecret:'corrected-private-secret'}});expect(changed.statusCode).toBe(200);expect(changed.body).not.toContain('corrected-private-secret');
        expect((await f.api('/v1/admin/entries/'+connection.id,'PUT',{name:'Stale',revision:connection.revision,credentials:{clientId:'fixture-app',clientSecret:'stale'}})).statusCode).toBe(409);
        await expect(f.host.entries!.accept(connection.id,message('old-generation','must not execute'),connection.revision)).rejects.toMatchObject({code:'CANCELLED'});
        expect(f.calls()).toBe(0);
    }finally{await f.close();}
},30000);

test('QR onboarding is owner-bound, expiring and stores platform credentials without returning them',async()=>{
    let queries=0;const qrFetch=async(url:any)=>new Response(JSON.stringify(String(url).includes('/generate')?{data:{scode:'fixture-scan-secret',auth_url:'https://work.weixin.qq.com/ai/qc/fixture'}}:{data:{status:++queries?'success':'pending',bot_info:{botid:'fixture-bot',secret:'fixture-bot-private-secret'}}}),{headers:{'content-type':'application/json'}});
    const f=await fixture({entryQrFetch:qrFetch});try{
        const create=await f.api('/v1/admin/entries/qr','POST',{name:'QR bot'});expect(create.statusCode).toBe(201);expect(create.json().qrImage).toMatch(/^data:image\/png;base64,/u);expect(create.body).not.toContain('fixture-scan-secret');
        const id=create.json().id;expect((await f.api('/v1/admin/entries/qr/'+id,'GET',undefined,'outsider')).statusCode).toBe(403);
        const result=await f.api('/v1/admin/entries/qr/'+id);expect(result.statusCode).toBe(200);expect(result.json().state).toBe('connected');expect(result.body).not.toContain('fixture-bot-private-secret');
        expect((await f.api('/v1/admin/entries')).json()).toHaveLength(1);expect((await f.host.db.pool.query('SELECT data FROM entry_connections')).rows[0].data.secret).not.toContain('fixture-bot-private-secret');
        expect((await f.api('/v1/admin/entries/qr/'+id)).json().connectionId).toBe(result.json().connectionId);expect(queries).toBe(1);
    }finally{await f.close();}
},30000);
