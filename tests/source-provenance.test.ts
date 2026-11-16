import{test,expect}from'vitest';
import{mkdir,mkdtemp}from'node:fs/promises';import{resolve}from'node:path';import Fastify from'fastify';
import{createFramework}from'../src/index.js';import{createServer}from'../src/server.js';import{HarnessRuntime}from'../src/runtime.js';
import{listenHttp}from'./helpers/http-server.js';

test('a public citation cannot launder a report derived from a private actual model input',async()=>{
    await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/lineage-'))}),app=await createServer(host),provider=Fastify();
    let calls=0,publicRef:any;const observed:any[]=[];
    const report=()=>({facts:[{text:'PRIVATE-DERIVED-FACT',refs:[publicRef]}],artifacts:[],issues:[]});
    const artifactInput={title:'PRIVATE-DERIVED-TITLE',domain:'derived',body:'PRIVATE-DERIVED-RESOURCE'};
    provider.post('/v1/messages',req=>{observed.push(req.body);return{id:'fixture',type:'message',role:'assistant',content:++calls===1?[{type:'tool_use',id:'artifact',name:'mcp__company__resource_create',input:artifactInput},{type:'tool_use',id:'report',name:'mcp__company__work_report',input:report()}]:[{type:'text',text:'PRIVATE-DERIVED-FINAL'}],stop_reason:calls===1?'tool_use':'end_turn',usage:{input_tokens:32,output_tokens:12}};});
    await listenHttp(provider);const runtime=new HarnessRuntime(app,host,{apiKey:'fixture',upstreamURL:provider.listeningOrigin});await listenHttp(app);
    try{
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({id:'admin',companyId:'one',role:'admin',permissions:[]});await host.putActor({id:'alice',companyId:'one',role:'employee',permissions:['report.self.write']});
        await host.putAgent({id:'job',ownerId:'alice',companyId:'one',pluginId:'@example/conformance',pluginVersion:'0.1.0',servicePermissions:['report.self.write'],allowedTools:[]});
        const publicEvidence=await host.resources.create('admin',{title:'Public reference',domain:'reference',kind:'document',body:'public evidence',access:{scope:'company',readerIds:[]},idempotencyKey:'public'});publicRef={id:publicEvidence.id,version:1};
        const privateEvidence=await host.resources.create('alice',{title:'Private source',domain:'reference',kind:'document',body:'PRIVATE-INPUT-SECRET',access:{scope:'personal',readerIds:[]},idempotencyKey:'private'});
        const headers={authorization:'Bearer '+await host.issueAccessToken('alice')},lease=(await app.inject({url:'/v1/harness/clients',method:'POST',headers,payload:{agentId:'job'}})).json();
        await app.inject({url:'/v1/harness/clients/'+lease.id+'/context',method:'PUT',headers,payload:{resources:[{id:privateEvidence.id,version:1}]}});
        const identity={'x-company-turn-id':'1','x-deepseek-harness-session-id':'chat',authorization:'Bearer '+lease.token};
        await app.inject({url:'/internal/client/'+lease.id+'/turn/start',method:'POST',headers:identity,payload:{sessionId:'chat',turnId:'1'}});
        const model=()=>app.inject({url:'/internal/client/'+lease.id+'/model/v1/messages',method:'POST',headers:{...identity,'x-api-key':lease.token},payload:{model:'deepseek-flash',max_tokens:128,messages:[{role:'user',content:'Summarize selected evidence'}],tools:[]}});
        expect((await model()).statusCode).toBe(200);expect(JSON.stringify(observed[0])).toContain('PRIVATE-INPUT-SECRET');
        const created=await app.inject({url:'/internal/client/'+lease.id+'/mcp',method:'POST',headers:identity,payload:{jsonrpc:'2.0',id:'artifact',method:'tools/call',params:{name:'resource_create',arguments:artifactInput}}});
        expect(created.json().result.isError).toBe(false);const artifact=JSON.parse(created.json().result.content[0].text);
        const recorded=await app.inject({url:'/internal/client/'+lease.id+'/mcp',method:'POST',headers:identity,payload:{jsonrpc:'2.0',id:'report',method:'tools/call',params:{name:'work_report',arguments:report()}}});
        expect(recorded.statusCode).toBe(200);expect(recorded.json().result.isError).toBe(false);expect((await model()).statusCode).toBe(200);
        const task=(await host.db.pool.query('SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1')).rows[0];
        const own=await host.results.view('alice',task.id);expect(own!.facts).toHaveLength(1);
        const requests=(await host.db.pool.query('SELECT data FROM model_context_requests ORDER BY created_at')).rows;
        expect(requests).toHaveLength(2);expect(requests[0].data.sources).toEqual(expect.arrayContaining([expect.objectContaining({kind:'resource',id:privateEvidence.id,version:1}),expect.objectContaining({kind:'input',ownerId:'alice'})]));
        expect(JSON.stringify(requests)).not.toContain('PRIVATE-INPUT-SECRET');
        const manager=await host.results.view('admin',task.id);expect(JSON.stringify(manager)).not.toContain('PRIVATE-DERIVED');expect(manager!.facts).toEqual([]);expect(manager!.control.state).toBe('succeeded');
        const shared=await host.resources.update('alice',artifact.id,{revision:artifact.revision,access:{scope:'personal',readerIds:['admin']}});
        await expect(host.resources.read('admin',artifact.id,1)).rejects.toMatchObject({code:'NOT_FOUND'});expect((await host.resources.index('admin','PRIVATE-DERIVED')).items).toEqual([]);
        await host.resources.update('alice',artifact.id,{revision:shared.revision,body:'Still derived text',sourceRefs:[]});await expect(host.resources.read('admin',artifact.id,2)).rejects.toMatchObject({code:'NOT_FOUND'});
    }finally{await runtime.close();await app.close();await provider.close();await host.close();}
});

test('legacy reports of unknown origin are not exposed or searchable through manager audit views',async()=>{
    await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/legacy-report-'))}),app=await createServer(host);
    try{
        await host.putActor({id:'admin',companyId:'one',role:'admin',permissions:[]});await host.putActor({id:'alice',companyId:'one',role:'employee',permissions:[]});
        await host.db.audit('report.recorded',{principalId:'alice',companyId:'one',summary:'LEGACY-PRIVATE-CONTENT'});
        const headers={authorization:'Bearer '+await host.issueAccessToken('admin')};
        const all=await app.inject({url:'/v1/admin/activity',headers});expect(all.body).not.toContain('LEGACY-PRIVATE-CONTENT');
        const searched=await app.inject({url:'/v1/admin/activity?q=LEGACY-PRIVATE-CONTENT',headers});expect(searched.json().items).toEqual([]);expect(searched.json().nextCursor).toBeNull();
    }finally{await app.close();await host.close();}
});
