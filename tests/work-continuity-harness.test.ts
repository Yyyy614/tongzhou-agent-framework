import {test,expect}from'vitest';
import Fastify from'fastify';
import{mkdir,mkdtemp}from'node:fs/promises';
import{resolve}from'node:path';
import{createFramework}from'../src/index.js';
import{createServer}from'../src/server.js';
import{TaskQueue}from'../src/tasks.js';
import{HarnessRuntime}from'../src/runtime.js';

test('a fresh Harness continuation reads only its bound checkpoint on demand instead of inheriting the old conversation',async()=>{
    const provider=Fastify();let calls=0,checkpointToolSeen=false,rawHistoryLeaked=false,checkpointResultSeen=false;
    provider.post('/v1/messages',async(request,reply)=>{
        const body=request.body as any;calls++;
        const tool=body.tools.find((t:any)=>t.name.endsWith('__work_checkpoint'))?.name;
        if(calls===2){checkpointToolSeen=!!tool;rawHistoryLeaked=JSON.stringify(body.messages).includes('FIRST_WORK_ONLY_RAW_MARKER');}
        if(calls===3)checkpointResultSeen=JSON.stringify(body.messages).includes('CONFIRMED_PRIOR_RESULT');
        const useTool=calls===2&&!!tool;
        const events:any[]=[['message_start',{type:'message_start',message:{id:'work-'+calls,type:'message',role:'assistant',model:'deepseek-flash',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:100,output_tokens:1}}}]];
        if(useTool)events.push(['content_block_start',{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'checkpoint-1',name:tool,input:{}}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{}'}}]);
        else events.push(['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:calls===1?'CONFIRMED_PRIOR_RESULT':checkpointResultSeen?'CONTINUED_WITH_CHECKPOINT':'CHECKPOINT_TOOL_MISSING'}}]);
        events.push(['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:useTool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:20}}],['message_stop',{type:'message_stop'}]);
        return reply.header('content-type','text/event-stream').send(events.map(([name,data])=>`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
    await provider.listen({host:'127.0.0.1',port:0});await mkdir('.test-data',{recursive:true});
    const host=await createFramework({root:await mkdtemp(resolve('.test-data/work-continuity-harness-'))}),app=await createServer(host);
    const runtime=new HarnessRuntime(app,host,{apiKey:'fixture',upstreamURL:provider.listeningOrigin}),queue=new TaskQueue(host,runtime);runtime.enableDelegation(queue);
    try{
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({id:'lead',companyId:'one',role:'employee',teamScope:'direct',permissions:['team.read','team.dispatch','team.review']});
        await host.putActor({id:'alice',companyId:'one',role:'employee',managerId:'lead',permissions:[]});
        await host.putAgent({id:'alice-agent',companyId:'one',ownerId:'alice',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});
        await queue.open();queue.registerRoutes(app);await app.listen({host:'127.0.0.1',port:0});await queue.startWorker();
        const work=await host.coordination!.create('lead',{title:'SDK continuation',idempotencyKey:'sdk-one',assignments:[{agentId:'alice-agent',prompt:'FIRST_WORK_ONLY_RAW_MARKER'}]});
        await expect.poll(async()=>(await host.coordination!.get('lead',work.id)).state,{timeout:15000}).toBe('waiting_review');
        const first=await host.coordination!.get('lead',work.id);
        const receipt=await host.coordination!.continuity.append('lead',work.id,{revision:first.revision,idempotencyKey:'sdk-two',assignments:[{agentId:'alice-agent',prompt:'Read your continuation checkpoint and complete only this new request.'}]},{kind:'http'});
        await expect.poll(async()=>(await queue.get(receipt.taskIds[0]!,'lead')).state,{timeout:15000}).toBe('succeeded');
        expect(checkpointToolSeen).toBe(true);expect(rawHistoryLeaked).toBe(false);expect(checkpointResultSeen).toBe(true);
        expect((await queue.get(receipt.taskIds[0]!,'lead')).output).toBe('CONTINUED_WITH_CHECKPOINT');
        const history=await host.coordination!.continuity.history('lead',work.id);expect(history.rounds).toHaveLength(2);
        const run=await runtime.get(history.rounds[1]!.assignments[0]!.runId,'alice');expect(run.workId).toBe(work.id);expect(run.workRound).toBe(2);
    }finally{await queue.close();await runtime.close();await app.close();await host.close();await provider.close();}
},40000);
