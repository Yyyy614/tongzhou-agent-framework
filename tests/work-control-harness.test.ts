import { listenHttp } from './helpers/http-server.js';
import{test,expect}from'vitest';
import Fastify from'fastify';
import{mkdir,mkdtemp}from'node:fs/promises';
import{resolve}from'node:path';
import{createFramework}from'../src/index.js';
import{createServer}from'../src/server.js';
import{TaskQueue}from'../src/tasks.js';
import{HarnessRuntime}from'../src/runtime.js';

test('real Harness waits without model polling and a fresh resumed Run reuses confirmed effect receipts',async()=>{
    const provider=Fastify();let calls=0,reused=false,checkpoint=false;
    provider.post('/v1/messages',async(request,reply)=>{
        const body=request.body as any;calls++;
        const local=calls===1||calls===3?'report_record':calls===2?'work_wait':calls===4?'work_checkpoint':null;
        const tool=body.tools.find((t:any)=>t.name.endsWith('__'+local))?.name;
        if(calls===4)reused=JSON.stringify(body.messages).includes('companyExecution');
        if(calls===5)checkpoint=JSON.stringify(body.messages).includes('confirmedActions');
        const input=local==='report_record'?{summary:'An already confirmed generic result'}:local==='work_wait'?{reason:'human_decision',question:'Choose an approved next step'}:{};
        const events:any[]=[['message_start',{type:'message_start',message:{id:'control-'+calls,type:'message',role:'assistant',model:'deepseek-flash',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:100,output_tokens:1}}}]];
        if(local&&tool)events.push(['content_block_start',{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'tool-'+calls,name:tool,input:{}}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(input)}}]);
        else events.push(['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'RESUMED_WITH_CONFIRMED_RESULT'}}]);
        events.push(['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:local&&tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:20}}],['message_stop',{type:'message_stop'}]);
        return reply.header('content-type','text/event-stream').send(events.map(([name,data])=>`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
    await listenHttp(provider);await mkdir('.test-data',{recursive:true});
    const host=await createFramework({root:await mkdtemp(resolve('.test-data/work-control-harness-'))}),app=await createServer(host);
    const runtime=new HarnessRuntime(app,host,{apiKey:'fixture',upstreamURL:provider.listeningOrigin}),queue=new TaskQueue(host,runtime);runtime.enableDelegation(queue);
    try{
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({id:'lead',companyId:'one',role:'employee',teamScope:'direct',permissions:['team.read','team.dispatch','team.review']});
        await host.putActor({id:'alice',companyId:'one',role:'employee',managerId:'lead',permissions:['report.self.write']});
        await host.putAgent({id:'alice-agent',companyId:'one',ownerId:'alice',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[],servicePermissions:['report.self.write']});
        await queue.open();queue.registerRoutes(app);await listenHttp(app);await queue.startWorker();
        const work=await host.coordination!.create('lead',{title:'SDK work control',idempotencyKey:'sdk-a2',assignments:[{agentId:'alice-agent',prompt:'Record a report then request human assistance.'}]});
        await expect.poll(async()=>(await host.coordination!.get('lead',work.id)).state,{timeout:18000}).toBe('waiting');
        const paused=await host.coordination!.get('lead',work.id);expect(paused.control.question).toBe('Choose an approved next step');
        await new Promise(r=>setTimeout(r,350));expect(calls).toBe(2);
        const oldTask=await queue.get(work.assignments[0]!.taskId,'lead');expect(oldTask.state).toBe('cancelled');
        const resumed=await host.coordination!.control.command('lead',work.id,{revision:paused.revision,idempotencyKey:'resume',action:'resume',reason:'Human approved the next step',assignments:[{agentId:'alice-agent',prompt:'Use the confirmed report receipt and finish the new instruction.'}]});
        await expect.poll(async()=>(await host.coordination!.get('lead',work.id)).state,{timeout:18000}).toBe('waiting_review');
        expect(reused).toBe(true);expect(checkpoint).toBe(true);expect(calls).toBe(5);
        expect((await host.db.pool.query("SELECT id FROM audit WHERE type='report.recorded'")).rowCount).toBe(1);
        expect((await host.db.pool.query("SELECT id FROM audit WHERE type='runtime.tool_reused'")).rowCount).toBe(1);
        expect((await queue.get(oldTask.id,'lead')).state).toBe('cancelled');expect(resumed.controlRevision).toBeGreaterThan(0);
    }finally{await queue.close();await runtime.close();await app.close();await host.close();await provider.close();}
},50000);

test.each([false,true])('a remote cancellation accepted=%s never masks a missing trustworthy terminal result',async(accepted)=>{
    const remote=Fastify();let started=false,finish=false;
    remote.post('/rpc',async(request)=>{const rpc=request.body as any;let result:any={accepted};
        if(rpc.method==='run.start'){started=true;result={runId:'remote-one',state:'running'};}
        if(rpc.method==='run.status')result={runId:'remote-one',state:finish?(accepted?'reconciliation_required':'succeeded'):'running'};
        if(rpc.method==='run.result')result={output:'remote done',evidenceRefs:['remote:one']};
        return{jsonrpc:'2.0',id:rpc.id,result};});
    await listenHttp(remote);await mkdir('.test-data',{recursive:true});
    const host=await createFramework({root:await mkdtemp(resolve('.test-data/work-control-remote-')),connections:{'connection:remote':{url:remote.listeningOrigin+'/rpc'}}}),app=await createServer(host);
    const runtime=new HarnessRuntime(app,host,{apiKey:'',upstreamURL:'https://example.invalid'}),queue=new TaskQueue(host,runtime);runtime.enableDelegation(queue);
    try{
        await host.installPlugin(resolve('fixtures/conformance-plugin'));await host.putActor({id:'lead',companyId:'one',role:'admin',permissions:[]});await host.putActor({id:'alice',companyId:'one',role:'employee',permissions:[]});
        await host.putAgent({id:'alice-agent',companyId:'one',ownerId:'alice',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[],runtime:'remote',connectionRef:'connection:remote'});
        await queue.open();queue.registerRoutes(app);await listenHttp(app);await queue.startWorker();
        const work=await host.coordination!.create('lead',{title:'Remote cancellation',idempotencyKey:'remote',assignments:[{agentId:'alice-agent',prompt:'generic work'}]});await expect.poll(()=>started,{timeout:8000}).toBe(true);
        await host.coordination!.control.command('lead',work.id,{revision:(await host.coordination!.get('lead',work.id)).revision,idempotencyKey:'stop',action:'stop',reason:'stop remote work'});
        finish=true;await expect.poll(async()=>(await host.coordination!.get('lead',work.id)).state,{timeout:10000}).toBe('reconciliation_required');
        expect((await queue.get(work.assignments[0]!.taskId,'lead')).state).toBe('reconciliation_required');
    }finally{finish=true;await queue.close();await runtime.close();await app.close();await host.close();await remote.close();}
},30000);
