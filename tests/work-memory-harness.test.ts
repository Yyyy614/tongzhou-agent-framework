import{test,expect}from'vitest';import{mkdir,mkdtemp}from'node:fs/promises';import{resolve}from'node:path';import Fastify from'fastify';
import{createFramework}from'../src/index.js';import{createServer}from'../src/server.js';import{HarnessRuntime}from'../src/runtime.js';import{TaskQueue}from'../src/tasks.js';import{listenHttp}from'./helpers/http-server.js';

test('native model requests restore bounded work notes and persisted entry bindings without importing another work',async()=>{
    await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/work-context-'))}),app=await createServer(host),provider=Fastify();const bodies:any[]=[];
    const updatedNote={expectedRevision:1,goal:'Goal A',decisions:[{text:'KEEP-ONLY-A',refs:[]}],blockers:[],nextSteps:[{text:'PERSISTED-NEXT-ACTION',refs:[]}],artifacts:[]};
    provider.post('/v1/messages',req=>{bodies.push(req.body);const writing=[3,5,7].includes(bodies.length);return{id:'fixture',type:'message',role:'assistant',content:writing?[{type:'tool_use',id:'save-note',name:'mcp__company__work_memory_save',input:updatedNote}]:[{type:'text',text:'Restored authorized work'}],stop_reason:writing?'tool_use':'end_turn',usage:{input_tokens:24,output_tokens:8}};});await listenHttp(provider);
    const runtime=new HarnessRuntime(app,host,{apiKey:'fixture',upstreamURL:provider.listeningOrigin}),queue=new TaskQueue(host,{async run(){throw Error('Reading work memory must not execute a queued task');}});
    try{
        await host.installPlugin(resolve('fixtures/conformance-plugin'));await host.putActor({id:'admin',companyId:'one',role:'admin',permissions:[]});await host.putActor({id:'alice',companyId:'one',role:'employee',permissions:[]});await host.putAgent({id:'job',ownerId:'alice',companyId:'one',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});
        await queue.open();queue.registerRoutes(app);await listenHttp(app);const works=[];for(const label of ['A','B']){const w=await host.coordination!.create('admin',{title:'Work '+label,idempotencyKey:label,assignments:[{agentId:'job',prompt:'Organize references'}]});works.push(w);await host.workMemory.save('alice',w.id,'job',{expectedRevision:0,idempotencyKey:'note',goal:'Goal '+label,decisions:[{text:'KEEP-ONLY-'+label,refs:[]}],blockers:[],nextSteps:[],artifacts:[]});}
        const artifact=await host.resources.create('alice',{title:'Handover artifact',kind:'document',domain:'handover',body:'Artifact body',access:{scope:'personal',readerIds:[]},idempotencyKey:'artifact'});
        const prior=await host.workMemory.read('alice',works[0].id,'job');await host.workMemory.save('alice',works[0].id,'job',{...prior.note,artifacts:[{id:artifact.id,version:1}],expectedRevision:prior.revision!,idempotencyKey:'attach'});updatedNote.expectedRevision=2;
        const headers={authorization:'Bearer '+await host.issueAccessToken('alice')};
        const open=async()=> (await app.inject({url:'/v1/harness/clients',method:'POST',headers,payload:{agentId:'job'}})).json();
        const model=async(lease:any,turn:string,input:string)=>{const identity={'x-company-turn-id':turn,'x-deepseek-harness-session-id':'stable-entry',authorization:'Bearer '+lease.token};await app.inject({url:'/internal/client/'+lease.id+'/turn/start',method:'POST',headers:identity,payload:{sessionId:'stable-entry',turnId:turn}});return app.inject({url:'/internal/client/'+lease.id+'/model/v1/messages',method:'POST',headers:{...identity,'x-api-key':lease.token},payload:{model:'deepseek-flash',max_tokens:128,messages:[{role:'user',content:input}],tools:[]}});};
        const first=await open();await app.inject({url:'/v1/harness/clients/'+first.id+'/context',method:'PUT',headers,payload:{workId:works[0].id,resources:[]}});
        expect((await model(first,'1','Read current work state')).statusCode).toBe(200);expect(JSON.stringify(bodies[0])).toContain('KEEP-ONLY-A');expect(JSON.stringify(bodies[0])).not.toContain('KEEP-ONLY-B');
        await app.inject({url:'/v1/harness/clients/'+first.id,method:'DELETE',headers});const second=await open();
        expect((await model(second,'2','查看刚才那项工作的状态')).statusCode).toBe(200);expect(JSON.stringify(bodies[1])).toContain('KEEP-ONLY-A');expect(JSON.stringify(bodies[1])).not.toContain('KEEP-ONLY-B');
        expect(JSON.stringify(bodies[0])).toContain(artifact.id);
        const compact=await host.workMemory.compact('alice',works[0].id,'job');expect(JSON.parse(compact.text).artifacts).toEqual([{id:artifact.id,version:1}]);
        const records=(await host.db.pool.query('SELECT data FROM model_context_requests ORDER BY created_at')).rows;expect(records[0].data.workMemoryRef).toMatchObject({revision:2,workId:works[0].id});
        const adminUsage=await app.inject({url:'/v1/admin/usage',headers:{authorization:'Bearer '+await host.issueAccessToken('admin')}});expect(adminUsage.statusCode).toBe(200);expect(adminUsage.json().records.length).toBeGreaterThan(0);expect(JSON.stringify(adminUsage.json().records)).not.toContain('workMemoryRef');
        expect((await model(second,'3','Update the current work note')).statusCode).toBe(200);
        const identity={'x-company-turn-id':'3','x-deepseek-harness-session-id':'stable-entry',authorization:'Bearer '+second.token};
        const saved=await app.inject({url:'/internal/client/'+second.id+'/mcp',method:'POST',headers:identity,payload:{jsonrpc:'2.0',id:'save-note',method:'tools/call',params:{name:'work_memory_save',arguments:updatedNote}}});expect(saved.json().result.isError).toBe(false);
        const final=await app.inject({url:'/internal/client/'+second.id+'/model/v1/messages',method:'POST',headers:{...identity,'x-api-key':second.token},payload:{model:'deepseek-flash',max_tokens:128,messages:[{role:'user',content:'continue current tool turn'}],tools:[]}});expect(final.statusCode).toBe(200);
        expect(JSON.stringify(bodies[3])).toContain('PERSISTED-NEXT-ACTION');expect((await host.workMemory.read('alice',works[0].id,'job')).revision).toBe(3);
        for (const turn of ['4','5']) {
            updatedNote.expectedRevision=Number(turn)-1;
            expect((await model(second,turn,'Continue and revise the current work')).statusCode).toBe(200);
            const identity={'x-company-turn-id':turn,'x-deepseek-harness-session-id':'stable-entry',authorization:'Bearer '+second.token};
            const saved=await app.inject({url:'/internal/client/'+second.id+'/mcp',method:'POST',headers:identity,payload:{jsonrpc:'2.0',id:'save-note',method:'tools/call',params:{name:'work_memory_save',arguments:updatedNote}}});
            expect(saved.json().result.isError).toBe(false);
            const final=await app.inject({url:'/internal/client/'+second.id+'/model/v1/messages',method:'POST',headers:{...identity,'x-api-key':second.token},payload:{model:'deepseek-flash',max_tokens:128,messages:[{role:'user',content:'finish'}],tools:[]}});
            expect(final.statusCode).toBe(200);expect((await host.workMemory.read('alice',works[0].id,'job')).derivedValidity).toBe('current');
        }
        expect((await app.inject({url:'/v1/harness/clients/'+second.id+'/context',method:'PUT',headers,payload:{resources:[]}})).statusCode).toBe(200);
        expect((await model(second,'6','Start an independent question')).statusCode).toBe(200);expect(JSON.stringify(bodies.at(-1))).not.toContain('KEEP-ONLY-A');
    }finally{await runtime.close();await queue.close();await app.close();await provider.close();await host.close();}
});
