import{test,expect}from'vitest';import{mkdir,mkdtemp}from'node:fs/promises';import{resolve}from'node:path';import{randomUUID}from'node:crypto';
import{createFramework}from'../src/index.js';import{createServer}from'../src/server.js';import{TaskQueue}from'../src/tasks.js';

test('withdrawn action sources keep successful actions immutable but block checkpoint payloads and receipt reuse',async()=>{
    await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/receipt-origin-'))}),app=await createServer(host);
    let phase=0,effects=0,source:any,checkpoint:any,denied='';
    const queue=new TaskQueue(host,{async run(request){const id=randomUUID();if(++phase===1){await host.provenance.add(id,'alice','job',await host.provenance.resourceOrigins(source));await host.coordination!.control.actions.execute(request,'effect@1',{operation:'one'},async()=>{effects++;return{receipt:'PRIVATE-RECEIPT'};},id);await host.coordination!.control.waitFromTask(request,{reason:'human_decision',question:'Wait for a decision'});return{id,state:'cancelled',output:''};}
        checkpoint=await host.coordination!.continuity.checkpointForTask('alice',request.taskId!);
        try{await host.coordination!.control.actions.execute(request,'effect@1',{operation:'one'},async()=>{effects++;return{receipt:'must not execute'};},id);}catch(error){denied=(error as any).code;}
        return{id,state:'succeeded',output:'No replay'};
    }});
    try{
        await host.installPlugin(resolve('fixtures/conformance-plugin'));await host.putActor({id:'lead',companyId:'one',role:'admin',permissions:[]});for(const id of ['alice','bob'])await host.putActor({id,companyId:'one',role:'employee',permissions:[]});await host.putAgent({id:'job',companyId:'one',ownerId:'alice',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});
        source=await host.resources.create('bob',{title:'Revocable',domain:'validation',kind:'document',body:'source',access:{scope:'personal',readerIds:['alice','lead']},idempotencyKey:'source'});
        await queue.open();queue.registerRoutes(app);const work=await host.coordination!.create('lead',{title:'Receipt test',idempotencyKey:'one',assignments:[{agentId:'job',prompt:'Effect then wait'}]});await queue.startWorker();
        await expect.poll(async()=>(await host.coordination!.get('lead',work.id)).state,{timeout:10000}).toBe('waiting');await host.resources.update('bob',source.id,{revision:source.revision,access:{scope:'personal',readerIds:['lead']}});
        const current=await host.coordination!.get('lead',work.id);await host.coordination!.control.command('lead',work.id,{revision:current.revision,idempotencyKey:'resume',action:'resume',reason:'Continue without redoing the confirmed action',assignments:[{agentId:'job',prompt:'Continue only remaining work'}]});
        await expect.poll(async()=>(await host.coordination!.get('lead',work.id)).state,{timeout:10000}).toBe('waiting_review');
        expect(JSON.stringify(checkpoint)).not.toContain('PRIVATE-RECEIPT');expect(denied).toBe('PERMISSION_DENIED');expect(effects).toBe(1);expect((await host.db.pool.query('SELECT state FROM work_actions')).rows[0].state).toBe('succeeded');
    }finally{await queue.close();await app.close();await host.close();}
},30000);
