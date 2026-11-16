import {test,expect} from 'vitest';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createFramework} from '../src/index.js';
import {createServer} from '../src/server.js';
import {TaskQueue,type TaskRequest} from '../src/tasks.js';
import {AdmissionBusyError} from '../src/errors.js';

async function fixture(execute?:(request:TaskRequest)=>Promise<{id:string;state:string;output?:string}>){
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data/work-continuity-'));
    const host=await createFramework({root}),app=await createServer(host),executed:TaskRequest[]=[];
    const queue=new TaskQueue(host,{async run(request){executed.push(request);return execute?execute(request):{id:randomUUID(),state:'succeeded',output:'Confirmed '+request.prompt};}});
    await host.installPlugin(resolve('fixtures/conformance-plugin'));
    await host.putActor({id:'lead',companyId:'one',role:'employee',teamScope:'direct',permissions:['team.read','team.dispatch','team.review']});
    await host.putActor({id:'alice',companyId:'one',role:'employee',managerId:'lead',permissions:[]});
    await host.putActor({id:'outsider',companyId:'two',role:'admin',permissions:[]});
    await host.putAgent({id:'alice-agent',companyId:'one',ownerId:'alice',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});
    await queue.open();queue.registerRoutes(app);
    const headers={authorization:'Bearer '+await host.issueAccessToken('lead')};
    const initial=await app.inject({method:'POST',url:'/v1/work',headers,payload:{title:'Generic continuing work',idempotencyKey:'first',assignments:[{agentId:'alice-agent',prompt:'first confirmed action'}]}});
    expect(initial.statusCode).toBe(202);await queue.startWorker();
    const id=initial.json().id;
    async function read(){return(await app.inject({url:'/v1/work/'+id,headers})).json();}
    await expect.poll(async()=>(await read()).state,{timeout:10000}).toBe('waiting_review');
    return{host,app,queue,root,headers,id,executed,read,close:async()=>{await queue.close();await app.close();await host.close();}};
}

test('HTTP and Bot continue the same work in new rounds while confirmed tasks and human reviews remain immutable',async()=>{
    const f=await fixture();
    try{
        const first=await f.read();
        expect((await f.app.inject({method:'POST',url:'/v1/work/'+f.id+'/review',headers:f.headers,payload:{revision:first.revision,decision:'reject',reason:'Please revise the result'}})).statusCode).toBe(200);
        const rejected=await f.read();
        const input={revision:rejected.revision,idempotencyKey:'adjust-one',assignments:[{agentId:'alice-agent',prompt:'apply only the requested correction'}]};
        const response=await f.app.inject({method:'POST',url:'/v1/work/'+f.id+'/inputs',headers:f.headers,payload:input});
        expect(response.statusCode).toBe(202);expect(response.json()).toMatchObject({workId:f.id,round:2,controlRevision:1,status:'accepted'});
        await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('waiting_review');
        const second=await f.read();expect(second.currentRound).toBe(2);expect(second.assignments[0].taskId).not.toBe(first.assignments[0].taskId);
        expect((await f.queue.get(first.assignments[0].taskId,'alice')).output).toBe('Confirmed first confirmed action');
        expect((await f.queue.get(first.assignments[0].taskId,'lead')).output).toBeUndefined();
        expect((await f.app.inject({method:'POST',url:'/v1/work/'+f.id+'/review',headers:f.headers,payload:{revision:second.revision,decision:'approve',reason:'Correction accepted'}})).statusCode).toBe(200);
        const message={agentId:'alice-agent',conversationId:'another-entry',messageId:'followup',text:'prepare one additional summary',workId:f.id,revision:(await f.read()).revision};
        const bot=await f.app.inject({method:'POST',url:'/v1/bot/messages',headers:f.headers,payload:message});expect(bot.statusCode).toBe(202);expect(bot.json().workId).toBe(f.id);
        expect((await f.app.inject({method:'POST',url:'/v1/bot/messages',headers:f.headers,payload:message})).json().id).toBe(bot.json().id);
        await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('waiting_review');
        const history=await f.app.inject({url:'/v1/work/'+f.id+'/history',headers:f.headers});expect(history.statusCode).toBe(200);
        expect(history.json().rounds).toHaveLength(3);expect(history.json().inputs.map((i:any)=>i.entry.kind)).toEqual(['http','bot']);
        expect(history.json().reviews.map((r:any)=>r.decision)).toEqual(['reject','approve']);
        expect(f.executed.map(r=>r.prompt)).toEqual(['first confirmed action','apply only the requested correction','prepare one additional summary']);
        expect(new Set(history.json().rounds.flatMap((r:any)=>r.assignments.map((a:any)=>a.runId))).size).toBe(3);
    }finally{await f.close();}
},30000);

test('work input is atomic and idempotent across concurrent delivery and two host restarts',async()=>{
    const f=await fixture();const first=await f.read();await f.close();
    let host=await createFramework({root:f.root}),app=await createServer(host),calls=0;
    let queue=new TaskQueue(host,{async run(){calls++;return{id:randomUUID(),state:'succeeded',output:'Only the new authorized action'};}});
    await queue.open();queue.registerRoutes(app);
    const input={revision:first.revision,idempotencyKey:'restart-followup',assignments:[{agentId:'alice-agent',prompt:'the new action'}]};
    try{
        const deliveries=await Promise.all(Array.from({length:6},()=>app.inject({method:'POST',url:'/v1/work/'+f.id+'/inputs',headers:f.headers,payload:input})));
        expect(deliveries.map(r=>r.statusCode)).toEqual([202,202,202,202,202,202]);expect(new Set(deliveries.map(r=>r.json().inputId)).size).toBe(1);
        expect((await app.inject({method:'POST',url:'/v1/work/'+f.id+'/inputs',headers:f.headers,payload:{...input,idempotencyKey:'stale-other-command'}})).statusCode).toBe(409);
        expect((await app.inject({method:'POST',url:'/v1/work/'+f.id+'/inputs',headers:f.headers,payload:{...input,assignments:[{agentId:'alice-agent',prompt:'changed under same key'}]}})).statusCode).toBe(409);
        await queue.close();await app.close();await host.close();
        host=await createFramework({root:f.root});app=await createServer(host);queue=new TaskQueue(host,{async run(){calls++;return{id:randomUUID(),state:'succeeded',output:'Only the new authorized action'};}});await queue.open();queue.registerRoutes(app);await queue.startWorker();
        await expect.poll(async()=>(await app.inject({url:'/v1/work/'+f.id,headers:f.headers})).json().state,{timeout:10000}).toBe('waiting_review');
        expect(calls).toBe(1);expect((await queue.get(first.assignments[0].taskId,'alice')).output).toBe('Confirmed first confirmed action');
        expect((await app.inject({method:'POST',url:'/v1/work/'+f.id+'/inputs',headers:f.headers,payload:input})).statusCode).toBe(202);
        expect((await app.inject({url:'/v1/work/'+f.id+'/history',headers:f.headers})).json().rounds).toHaveLength(2);
    }finally{await queue.close();await app.close();await host.close();}
},30000);

test('follow-ups cannot expand participants, forge identity, read foreign history or replay an uncertain result',async()=>{
    const f=await fixture(async request=>({id:randomUUID(),state:request.prompt==='uncertain new action'?'reconciliation_required':'succeeded',output:'Known result'}));
    try{
        const current=await f.read();const body={revision:current.revision,idempotencyKey:'bounded',assignments:[{agentId:'alice-agent',prompt:'uncertain new action'}]};
        const outsider={authorization:'Bearer '+await f.host.issueAccessToken('outsider')};
        expect((await f.app.inject({url:'/v1/work/'+f.id+'/history',headers:outsider})).statusCode).toBe(403);
        expect((await f.app.inject({method:'POST',url:'/v1/work/'+f.id+'/inputs',headers:outsider,payload:body})).statusCode).toBe(403);
        await f.host.putActor({id:'bob',companyId:'one',role:'employee',managerId:'lead',permissions:[]});
        await f.host.putAgent({id:'bob-agent',companyId:'one',ownerId:'bob',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});
        expect((await f.app.inject({method:'POST',url:'/v1/work/'+f.id+'/inputs',headers:f.headers,payload:{...body,assignments:[{agentId:'bob-agent',prompt:'scope expansion'}]}})).statusCode).toBe(403);
        expect((await f.app.inject({method:'POST',url:'/v1/work/'+f.id+'/inputs',headers:f.headers,payload:{...body,principalId:'outsider'}})).statusCode).toBe(400);
        expect((await f.app.inject({method:'POST',url:'/v1/work/'+f.id+'/inputs',headers:f.headers,payload:body})).statusCode).toBe(202);
        await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('reconciliation_required');
        expect((await f.app.inject({method:'POST',url:'/v1/work/'+f.id+'/inputs',headers:f.headers,payload:{...body,revision:(await f.read()).revision,idempotencyKey:'cannot-replay-unknown'}})).statusCode).toBe(409);
        expect(f.executed).toHaveLength(2);
    }finally{await f.close();}
},30000);

test('a continuation checkpoint contains only the executing employee previous result and requires current memory-independent work access',async()=>{
    const f=await fixture();
    try{
        const first=await f.read();const receipt=await f.host.coordination!.continuity.append('lead',f.id,{revision:first.revision,idempotencyKey:'checkpoint',assignments:[{agentId:'alice-agent',prompt:'explicit new action'}]},{kind:'http'});
        const checkpoint=await f.host.coordination!.continuity.checkpointForTask('alice',receipt.taskIds[0]!);
        expect(checkpoint.confirmedTask).toMatchObject({taskId:first.assignments[0].taskId,state:'succeeded',summary:'执行已结束，等待人工核对',result:{processAvailable:true}});
        const reference=checkpoint.confirmedTask.result.processRef;
        expect((await f.host.resources.read('alice',reference.id,reference.version)).body).toBe('Confirmed first confirmed action');
        await f.host.db.pool.query('DELETE FROM task_results WHERE task_id=$1',[first.assignments[0].taskId]);
        await f.host.db.pool.query('UPDATE tasks SET data=data||$2::jsonb WHERE id=$1',[first.assignments[0].taskId,JSON.stringify({resultFormat:'references-v1',output:'MISSING-RESULT-PRIVATE-RAW'})]);
        const missing=await f.host.coordination!.continuity.checkpointForTask('alice',receipt.taskIds[0]!);expect(JSON.stringify(missing)).not.toContain('MISSING-RESULT-PRIVATE-RAW');expect(missing.confirmedTask!.summary).toBe('执行记录待整理或核实');
        await expect(f.host.coordination!.continuity.checkpointForTask('lead',receipt.taskIds[0]!)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
        await f.host.putActor({id:'alice',companyId:'one',role:'employee',managerId:null,active:false,permissions:[]});
        await expect(f.host.coordination!.continuity.checkpointForTask('alice',receipt.taskIds[0]!)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    }finally{await f.close();}
},30000);

test('an active round cannot be superseded by another input',async()=>{
    let entered!:()=>void,release!:()=>void;const active=new Promise<void>(r=>entered=r),barrier=new Promise<void>(r=>release=r);
    const f=await fixture(async request=>{if(request.prompt==='hold current action'){entered();await barrier;}return{id:randomUUID(),state:'succeeded',output:'confirmed'};});
    try{
        await f.host.coordination!.continuity.append('lead',f.id,{revision:(await f.read()).revision,idempotencyKey:'hold',assignments:[{agentId:'alice-agent',prompt:'hold current action'}]},{kind:'http'});
        await active;
        const response=await f.app.inject({method:'POST',url:'/v1/work/'+f.id+'/inputs',headers:f.headers,payload:{revision:(await f.read()).revision,idempotencyKey:'interrupt',assignments:[{agentId:'alice-agent',prompt:'must not replace active work'}]}});
        expect(response.statusCode).toBe(409);expect(f.executed).toHaveLength(2);
    }finally{release();await f.close();}
},30000);

test('changed accepted capability bindings are refused during admission retry without executing a new action',async()=>{
    let entered!:()=>void;const busy=new Promise<void>(r=>entered=r);let effects=0;
    const f=await fixture(async request=>{if(request.workInputId){entered();throw new AdmissionBusyError('BUSY','fixture admission only');}effects++;return{id:randomUUID(),state:'succeeded',output:'confirmed'};});
    try{
        const receipt=await f.host.coordination!.continuity.append('lead',f.id,{revision:(await f.read()).revision,idempotencyKey:'binding',assignments:[{agentId:'alice-agent',prompt:'new action after admission'}]},{kind:'http'});
        await busy;
        await f.host.putAgent({id:'alice-agent',companyId:'one',ownerId:'alice',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[],instructions:'configuration changed after acceptance'});
        await expect.poll(async()=>(await f.queue.get(receipt.taskIds[0]!,'lead')).state,{timeout:10000}).toBe('failed');
        expect(effects).toBe(1);expect((await f.queue.get(receipt.taskIds[0]!,'lead')).error.code).toBe('PERMISSION_DENIED');
    }finally{await f.close();}
},30000);

test('supervision and inbox deduplication follow each new round after a completed or rejected round',async()=>{
    const f=await fixture(async request=>({id:randomUUID(),state:request.prompt==='known failure in new round'?'failed':'succeeded',output:'confirmed work fact'}));
    try{
        await f.host.putActor({id:'lead',companyId:'one',role:'employee',teamScope:'direct',permissions:['team.read','team.dispatch','team.review','inbox.self.read']});
        async function notifications(){return(await f.app.inject({url:'/v1/assistant/inbox',headers:f.headers})).json();}
        for(const decision of ['approve','reject'] as const){
            await f.host.assistant!.runOnce();
            const before=await f.read();await f.host.coordination!.review('lead',f.id,{revision:before.revision,decision,reason:'Review round '+before.currentRound});
            await f.host.assistant!.runOnce();
            await f.host.coordination!.continuity.append('lead',f.id,{revision:(await f.read()).revision,idempotencyKey:'after-'+decision,assignments:[{agentId:'alice-agent',prompt:'follow-up after '+decision}]},{kind:'http'});
            await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('waiting_review');
            await f.host.assistant!.runOnce();
        }
        const notices=await notifications();expect(notices.filter((n:any)=>n.kind==='work.review_required')).toHaveLength(3);
        expect(notices.filter((n:any)=>n.kind==='work.review_required').map((n:any)=>n.data.round).sort()).toEqual([1,2,3]);
        await f.host.assistant!.runOnce();expect((await notifications()).filter((n:any)=>n.kind==='work.review_required')).toHaveLength(3);
        await f.host.coordination!.review('lead',f.id,{revision:(await f.read()).revision,decision:'approve',reason:'Third round accepted'});await f.host.assistant!.runOnce();
        await f.host.coordination!.continuity.append('lead',f.id,{revision:(await f.read()).revision,idempotencyKey:'failure-after-completed',assignments:[{agentId:'alice-agent',prompt:'known failure in new round'}]},{kind:'http'});
        await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('needs_attention');await f.host.assistant!.runOnce();
        expect((await notifications()).filter((n:any)=>n.kind==='work.needs_attention').map((n:any)=>n.data.round)).toEqual([4]);
    }finally{await f.close();}
},30000);

test('a partial participant gets only their bounded checkpoint even when other participants have private results',async()=>{
    const f=await fixture();
    try{
        await f.host.putActor({id:'bob',companyId:'one',role:'employee',managerId:'lead',permissions:[]});
        await f.host.putAgent({id:'bob-agent',companyId:'one',ownerId:'bob',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});
        const work=await f.host.coordination!.create('lead',{title:'Independent parallel results',idempotencyKey:'multiple-results',assignments:[{agentId:'alice-agent',prompt:'A'.repeat(3000)},{agentId:'bob-agent',prompt:'BOB_RESULT_MUST_NOT_LEAK'}]});
        await expect.poll(async()=>(await f.host.coordination!.get('lead',work.id)).state,{timeout:10000}).toBe('waiting_review');
        const receipt=await f.host.coordination!.continuity.append('lead',work.id,{revision:(await f.host.coordination!.get('lead',work.id)).revision,idempotencyKey:'only-alice',assignments:[{agentId:'alice-agent',prompt:'use only own previous result'}]},{kind:'http'});
        const checkpoint=await f.host.coordination!.continuity.checkpointForTask('alice',receipt.taskIds[0]!);
        expect(checkpoint.confirmedTask.summary).toBe('执行已结束，等待人工核对');expect(checkpoint.summaryTruncated).toBe(false);expect(JSON.stringify(checkpoint)).not.toMatch(/bob|BOB_RESULT/u);
        expect(JSON.stringify(checkpoint)).not.toContain('A'.repeat(500));
        const source=checkpoint.confirmedTask.result.processRef;expect((await f.host.resources.read('alice',source.id,source.version)).body).toBe('Confirmed '+'A'.repeat(3000));
        await expect(f.host.coordination!.continuity.history('alice',work.id)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
        await expect(f.host.coordination!.continuity.input('alice',work.id,receipt.inputId)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
        await expect(f.host.coordination!.continuity.checkpointForTask('bob',receipt.taskIds[0]!)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    }finally{await f.close();}
},30000);

test('continuing nested work keeps its original shared budget group instead of gaining a fresh work budget',async()=>{
    const f=await fixture();
    try{
        const budgetGroupId=randomUUID();
        const work=await f.host.coordination!.create('lead',{title:'Shared bounded work',idempotencyKey:'shared-budget',budgetGroupId,assignments:[{agentId:'alice-agent',prompt:'first action under the shared budget'}]});
        await expect.poll(async()=>(await f.host.coordination!.get('lead',work.id)).state,{timeout:10000}).toBe('waiting_review');
        await f.host.coordination!.continuity.append('lead',work.id,{revision:(await f.host.coordination!.get('lead',work.id)).revision,idempotencyKey:'same-budget',assignments:[{agentId:'alice-agent',prompt:'additional action under the same budget'}]},{kind:'http'});
        await expect.poll(async()=>(await f.host.coordination!.get('lead',work.id)).state,{timeout:10000}).toBe('waiting_review');
        expect(f.executed.filter(request=>request.workId===work.id).map(request=>request.budgetGroupId)).toEqual([budgetGroupId,budgetGroupId]);
    }finally{await f.close();}
},30000);
