import {test,expect} from 'vitest';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createFramework} from '../src/index.js';
import {createServer} from '../src/server.js';
import {TaskQueue} from '../src/tasks.js';

for(const provider of ['dingtalk','feishu','wecom'] as const)test('company-managed '+provider+' assigns and continues work without employee pairing',async()=>{
    await mkdir('.test-data',{recursive:true});let receive:any;const sent:string[]=[];
    const host=await createFramework({root:await mkdtemp(resolve('.test-data/managed-entry-')),entries:true,entryTransportFactory:async(_p,_c,hooks)=>{receive=hooks.receive;return{send:async(_r,text)=>{sent.push(text);},close:async()=>{}};}});
    const app=await createServer(host);let executions=0;const queue=new TaskQueue(host,{async run(){executions++;return{id:randomUUID(),state:'succeeded',output:'PRIVATE-PROCESS'};}});
    try{
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        for(const [id,role] of [['admin','admin'],['alice','employee']] as const)await host.putActor({id,role,companyId:'one',permissions:[]});
        await host.putAgent({id:'job',ownerId:'alice',companyId:'one',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[],preset:{id:'company-worker',version:'0.1.0'}});
        await queue.open();queue.registerRoutes(app);const headers={authorization:'Bearer '+await host.issueAccessToken('admin')};
        const credentials=provider==='dingtalk'?{clientId:'managed-ding',clientSecret:'fixture'}:provider==='feishu'?{appId:'managed-feishu',appSecret:'fixture'}:{botId:'managed-wecom',secret:'fixture'};
        const connection=(await app.inject({url:'/v1/admin/entries',method:'POST',headers,payload:{name:'Managed '+provider,provider,credentials}})).json();
        const config={name:'Company responsibilities',enabled:true,mode:'execute',allowedPrincipalIds:['alice'],semantic:false,mappings:[{externalId:'verified-external-user',principalId:'alice',connectionId:connection.id}],targets:[{presetId:'company-worker',eventTypes:['message'],description:'Generic employee responsibility'}]};
        const source=(await app.inject({url:'/v1/admin/event-sources',method:'POST',headers,payload:config})).json();
        await host.entries!.start();await queue.startWorker();
        const message=(id:string)=>({externalUserId:'verified-external-user',conversationId:'same-thread',messageId:id,text:'bounded follow-up '+id,isGroup:false,reply:{session:'fixture'}});
        const first=await receive(message('1'));expect(first.accepted).toBe(true);expect(first.managed).toBe(true);
        await expect.poll(()=>sent.length,{timeout:12000}).toBe(1);expect(sent[0]).not.toContain('PRIVATE-PROCESS');
        const firstEvent=await host.events.get('admin',first.id);const workId=firstEvent.workId;
        expect((await host.coordination!.get('admin',workId)).currentRound).toBe(1);
        expect((await receive(message('1'))).id).toBe(first.id);
        await receive(message('2'));await expect.poll(()=>sent.length,{timeout:12000}).toBe(2);
        expect((await host.coordination!.get('admin',workId)).currentRound).toBe(2);expect(executions).toBe(2);
        expect((await host.db.pool.query('SELECT * FROM entry_bindings')).rowCount).toBe(0);
        expect((await receive({...message('3'),externalUserId:'unknown'})).accepted).toBe(false);
        await app.inject({url:'/v1/admin/event-sources/'+source.id,method:'PUT',headers,payload:{...config,enabled:false,revision:source.revision}});
        expect((await receive(message('4'))).accepted).toBe(false);
    }finally{await queue.close();await app.close();await host.close();}
},30000);
