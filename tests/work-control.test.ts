import{test,expect}from'vitest';
import{mkdir,mkdtemp}from'node:fs/promises';
import{resolve}from'node:path';
import{randomUUID}from'node:crypto';
import{createFramework}from'../src/index.js';
import{createServer}from'../src/server.js';
import{TaskQueue,type TaskRequest}from'../src/tasks.js';
import{contentHash}from'../src/contracts.js';

async function fixture(execute?:(request:TaskRequest,host:any)=>Promise<any>){
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data/work-a2-'));
    const host=await createFramework({root}),app=await createServer(host);let calls=0;
    const queue=new TaskQueue(host,{async run(request){calls++;return execute?execute(request,host):{id:randomUUID(),state:'succeeded',output:'confirmed'};}});
    await host.installPlugin(resolve('fixtures/conformance-plugin'));
    await host.putActor({id:'lead',companyId:'one',role:'employee',teamScope:'direct',permissions:['team.read','team.dispatch','team.review','inbox.self.read']});
    await host.putActor({id:'alice',companyId:'one',role:'employee',managerId:'lead',permissions:[]});
    await host.putAgent({id:'alice-agent',companyId:'one',ownerId:'alice',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});
    await queue.open();queue.registerRoutes(app);const headers={authorization:'Bearer '+await host.issueAccessToken('lead')};
    const work=await host.coordination!.create('lead',{title:'Controlled generic work',idempotencyKey:'one',assignments:[{agentId:'alice-agent',prompt:'execute current instruction'}]});
    const read=async()=>(await app.inject({url:'/v1/work/'+work.id,headers})).json();
    const command=async(action:string,extra:any={})=>app.inject({method:'POST',url:'/v1/work/'+work.id+'/control',headers,payload:{revision:(await read()).revision,idempotencyKey:randomUUID(),action,reason:'Explicit responsible-person decision',...extra}});
    return{host,app,queue,root,headers,work,read,command,calls:()=>calls,close:async()=>{await queue.close();await app.close();await host.close();}};
}

test('stopping queued work persists a fence and the queued task never executes',async()=>{
    const f=await fixture();
    try{
        const response=await f.command('stop');expect(response.statusCode).toBe(202);
        await f.queue.startWorker();await new Promise(r=>setTimeout(r,350));
        expect((await f.read()).state).toBe('stopped');expect(f.calls()).toBe(0);
        expect((await f.queue.get(f.work.assignments[0]!.taskId,'lead')).state).toBe('cancelled');
        const prior=await f.queue.get(f.work.assignments[0]!.taskId,'lead');
        expect((await f.command('resume',{assignments:[{agentId:'alice-agent',prompt:'new explicitly approved attempt'}]})).statusCode).toBe(202);
        await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('waiting_review');
        expect((await f.queue.get(prior.id,'lead')).state).toBe('cancelled');expect(f.calls()).toBe(1);
    }finally{await f.close();}
},30000);

test('stop closes new effects, drains an admitted effect and resume reuses its confirmed receipt',async()=>{
    let entered!:()=>void,release!:()=>void;const active=new Promise<void>(r=>entered=r),barrier=new Promise<void>(r=>release=r);let effects=0,reused=false,oldRequest:TaskRequest|undefined;
    const f=await fixture(async(request,host)=>{
        const result=await host.coordination.control.actions.execute(request,'generic-effect',{operation:'one'},async()=>{effects++;if(effects===1){oldRequest=request;entered();await barrier;}return{receipt:'first confirmed'};});
        reused=result.reused;
        return{id:randomUUID(),state:'succeeded',output:result.value.receipt};
    });
    try{
        await f.queue.startWorker();await active;
        expect((await f.command('stop')).statusCode).toBe(202);expect((await f.read()).state).toBe('stop_requested');
        await expect(f.host.coordination!.control.actions.execute(oldRequest!,'another-effect',{},async()=>{effects++;return{};})).rejects.toMatchObject({code:'CANCELLED'});
        release();await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('stopped');
        expect((await f.command('resume',{assignments:[{agentId:'alice-agent',prompt:'resume using the existing receipt'}]})).statusCode).toBe(202);
        await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('waiting_review');expect(effects).toBe(1);expect(reused).toBe(true);
    }finally{release();await f.close();}
},30000);

test('uncertain effects require independent human reconciliation before resume and never execute again after confirmation',async()=>{
    let effects=0;
    const f=await fixture(async(request,host)=>{const result=await host.coordination.control.actions.execute(request,'external-effect',{operation:'one'},async()=>{effects++;throw Error('Effect happened but receipt was lost');});return{id:randomUUID(),state:'succeeded',output:result.value.receipt};});
    try{
        await f.queue.startWorker();await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('reconciliation_required');
        expect((await f.command('resume',{assignments:[{agentId:'alice-agent',prompt:'must not replay unknown effect'}]})).statusCode).toBe(409);
        const ledger=await f.app.inject({url:'/v1/work/'+f.work.id+'/control',headers:f.headers});expect(ledger.statusCode).toBe(200);
        const action=ledger.json().actions[0];expect(action.state).toBe('unknown');
        const resolved=await f.app.inject({method:'POST',url:'/v1/work/'+f.work.id+'/reconcile',headers:f.headers,payload:{revision:(await f.read()).revision,idempotencyKey:'verified-once',reason:'Verified the effect and the previous executor is closed',evidenceRefs:['external:verified-receipt'],actions:[{actionId:action.id,outcome:'succeeded',value:{receipt:'verified external receipt'}}],tasks:[{taskId:f.work.assignments[0]!.taskId,outcome:'closed'}]}});
        expect(resolved.statusCode).toBe(200);
        expect((await f.command('resume',{assignments:[{agentId:'alice-agent',prompt:'resume from the manually confirmed receipt'}]})).statusCode).toBe(202);
        await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('waiting_review');expect(effects).toBe(1);
        expect((await f.queue.get(f.work.assignments[0]!.taskId,'lead')).state).toBe('reconciliation_required');
    }finally{await f.close();}
},30000);

test('an executing employee can request a durable human wait without manager authority and only a manager can resume',async()=>{
    let first=true;
    const f=await fixture(async(request,host)=>{
        if(first){first=false;await host.coordination.control.waitFromTask(request,{reason:'human_decision',question:'Which approved option should be used?'});return{id:randomUUID(),state:'cancelled',output:''};}
        return{id:randomUUID(),state:'succeeded',output:'used explicit human decision'};
    });
    try{
        await f.queue.startWorker();await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('waiting');
        expect((await f.read()).control.question).toBe('Which approved option should be used?');
        const aliceHeaders={authorization:'Bearer '+await f.host.issueAccessToken('alice')};
        const denied=await f.app.inject({method:'POST',url:'/v1/work/'+f.work.id+'/control',headers:aliceHeaders,payload:{revision:(await f.read()).revision,idempotencyKey:'no',action:'resume',reason:'I have no dispatch authority',assignments:[{agentId:'alice-agent',prompt:'continue'}]}});
        expect(denied.statusCode).toBe(403);
        expect((await f.command('resume',{assignments:[{agentId:'alice-agent',prompt:'Use the explicitly approved option'}]})).statusCode).toBe(202);
        await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('waiting_review');expect(f.calls()).toBe(2);
    }finally{await f.close();}
},30000);

test('duplicate and stale control requests cannot close a newer recovery round or cross current authorization',async()=>{
    const f=await fixture();
    try{
        const payload={revision:(await f.read()).revision,idempotencyKey:'fixed-stop',action:'stop',reason:'Explicit stop'};
        const send=()=>f.app.inject({method:'POST',url:'/v1/work/'+f.work.id+'/control',headers:f.headers,payload});
        const stopped=(await send()).json();
        const stale=await f.command('wait',{revision:payload.revision});expect(stale.statusCode).toBe(409);
        expect((await f.command('resume',{assignments:[{agentId:'alice-agent',prompt:'fresh explicitly approved attempt'}]})).statusCode).toBe(202);
        const before=await f.read();expect((await send()).json()).toEqual(stopped);expect((await f.read()).revision).toBe(before.revision);expect((await f.read()).state).toBe('queued');
        await f.host.putActor({id:'lead',companyId:'one',role:'employee',teamScope:'none',permissions:[]});expect((await f.command('stop',{revision:before.revision})).statusCode).toBe(403);
        await f.host.putActor({id:'outsider',companyId:'two',role:'admin',permissions:[]});
        const other=await f.app.inject({url:'/v1/work/'+f.work.id+'/control',headers:{authorization:'Bearer '+await f.host.issueAccessToken('outsider')}});expect(other.statusCode).toBe(403);
        expect((await f.host.db.pool.query('SELECT id FROM work_controls')).rowCount).toBe(2);
    }finally{await f.close();}
},30000);

test('a company administrator can stop plugin-originated work after its source dispatch grant is revoked',async()=>{
    const f=await fixture();
    try{
        const plugin=await f.host.installPlugin(resolve('packages/work-assistant')),tools=plugin.manifest.provides.tools.map(t=>plugin.id+':'+t.id),grants=plugin.manifest.permissions;
        await f.host.putActor({id:'lead',companyId:'one',role:'employee',teamScope:'direct',permissions:['team.read','team.dispatch',...grants,...tools.map(t=>'tool.invoke:'+t)]});
        await f.host.putAgent({id:'lead-agent',companyId:'one',ownerId:'lead',pluginId:plugin.id,pluginVersion:plugin.version,allowedTools:tools,servicePermissions:grants,delegates:['alice-agent']});
        const work=await f.host.coordination!.create('lead',{title:'Plugin-origin work',idempotencyKey:'source',sourceAgentId:'lead-agent',sourceToolRef:plugin.id+':work.dispatch',sourcePluginVersion:plugin.version,assignments:[{agentId:'alice-agent',prompt:'generic'}]});
        await f.host.putActor({id:'admin',companyId:'one',role:'admin',permissions:[]});
        const source=await f.host.db.get<any>('agents','lead-agent');await f.host.putAgent({...source,servicePermissions:[]});
        const result=await f.app.inject({method:'POST',url:'/v1/work/'+work.id+'/control',headers:{authorization:'Bearer '+await f.host.issueAccessToken('admin')},payload:{revision:(await f.host.coordination!.get('admin',work.id)).revision,idempotencyKey:'admin-stop',action:'stop',reason:'Source capability revoked, stop existing execution'}});
        expect(result.statusCode).toBe(202);expect((await f.host.coordination!.get('admin',work.id)).state).toBe('stopped');
    }finally{await f.close();}
},30000);

test('human verification cannot turn a malformed installed-plugin receipt into a reusable success',async()=>{
    const f=await fixture(async(request,host)=>{await host.coordination.control.actions.execute(request,'@example/conformance:text.normalize@0.1.0',{text:'test'},async()=>{throw Error('unknown');});return{id:randomUUID(),state:'succeeded'};});
    try{
        await f.queue.startWorker();await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('reconciliation_required');
        const ledger=(await f.app.inject({url:'/v1/work/'+f.work.id+'/control',headers:f.headers})).json();
        const result=await f.app.inject({method:'POST',url:'/v1/work/'+f.work.id+'/reconcile',headers:f.headers,payload:{revision:(await f.read()).revision,idempotencyKey:'invalid-receipt',reason:'This is wrong-shaped evidence',evidenceRefs:['fixture:receipt'],actions:[{actionId:ledger.actions[0].id,outcome:'succeeded',value:{outcome:'succeeded',output:{text:123}}}]}});
        expect(result.statusCode).toBe(400);expect((await f.host.db.pool.query('SELECT state FROM work_actions')).rows[0].state).toBe('unknown');
        await f.host.putActor({id:'admin',companyId:'one',role:'admin',permissions:[]});await f.host.setPluginEnabled({principalId:'admin',pluginId:'@example/conformance',version:'0.1.0',enabled:false});
        const valid=await f.app.inject({method:'POST',url:'/v1/work/'+f.work.id+'/reconcile',headers:f.headers,payload:{revision:(await f.read()).revision,idempotencyKey:'valid-disabled-receipt',reason:'Verify the completed receipt without enabling new execution',evidenceRefs:['fixture:valid-receipt'],actions:[{actionId:ledger.actions[0].id,outcome:'succeeded',value:{invocationId:randomUUID(),runId:randomUUID(),outcome:'succeeded',output:{text:'confirmed'},evidenceRefs:['fixture:original-receipt']}}]}});expect(valid.statusCode).toBe(200);expect(f.host.registry.list()[0]!.enabled).toBe(false);
    }finally{await f.close();}
},30000);

test('disabling a target employee does not prevent the administrator stopping its existing work',async()=>{
    const f=await fixture();
    try{
        await f.host.putActor({id:'admin',companyId:'one',role:'admin',permissions:[]});const agent=await f.host.db.get<any>('agents','alice-agent');await f.host.putAgent({...agent,active:false});
        const revision=(await f.read()).revision;
        const result=await f.app.inject({method:'POST',url:'/v1/work/'+f.work.id+'/control',headers:{authorization:'Bearer '+await f.host.issueAccessToken('admin')},payload:{revision,idempotencyKey:'disable-stop',action:'stop',reason:'Employee was disabled; shut down existing work'}});
        expect(result.statusCode).toBe(202);expect((await f.read()).state).toBe('stopped');
    }finally{await f.close();}
},30000);

test('loading an already reviewed A1 continuation preserves its original revision and review',async()=>{
    const f=await fixture();
    try{
        await f.queue.startWorker();await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('waiting_review');
        await f.host.coordination!.continuity.append('lead',f.work.id,{revision:(await f.read()).revision,idempotencyKey:'a1-followup',assignments:[{agentId:'alice-agent',prompt:'original A1 continuation'}]},{kind:'http'});
        await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('waiting_review');
        const snapshot=await f.host.coordination!.snapshot(f.work.id);
        // The persisted A1 hash contract, before A2 added control columns.
        const a1Revision=contentHash({id:f.work.id,data:snapshot.work.data,controlRevision:snapshot.work.control_revision,currentRound:snapshot.work.current_round,tasks:snapshot.tasks.map(t=>({id:t.id,state:t.state,data:t.data}))});
        await f.host.db.pool.query('INSERT INTO work_reviews(work_id,revision,reviewed_by,decision,reason) VALUES($1,$2,$3,$4,$5)',[f.work.id,a1Revision,'lead','approve','Original A1 review']);
        const result=await f.read();expect(result.state).toBe('completed');expect(result.revision).toBe(a1Revision);expect(result.review.reason).toBe('Original A1 review');
    }finally{await f.close();}
},30000);

test('the control ledger exposes current unknown actions even with more than 256 older receipts',async()=>{
    const f=await fixture(async(request,host)=>{await host.coordination.control.actions.execute(request,'current-effect',{},async()=>{throw Error('unknown current effect');});return{id:randomUUID(),state:'succeeded'};});
    try{
        for(let i=0;i<257;i++)await f.host.db.pool.query('INSERT INTO work_actions(id,work_id,action_scope,agent_id,task_id,action_key,state,data) VALUES($1,$2,1,$3,$4,$5,$6,$7)',[randomUUID(),f.work.id,'alice-agent',f.work.assignments[0]!.taskId,'old-'+i,'succeeded',JSON.stringify({toolRef:'previous-effect',value:{receipt:'old'}})]);
        await f.queue.startWorker();await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('reconciliation_required');
        const record=(await f.app.inject({url:'/v1/work/'+f.work.id+'/control',headers:f.headers})).json();expect(record.actions.some((a:any)=>a.state==='unknown')).toBe(true);expect(record.actionsTruncated).toBe(true);
    }finally{await f.close();}
},30000);

test('a partially visible participant cannot read another employees human-wait question',async()=>{
    const f=await fixture();
    try{
        await f.host.putActor({id:'bob',companyId:'one',role:'employee',managerId:'lead',permissions:[]});await f.host.putAgent({id:'bob-agent',companyId:'one',ownerId:'bob',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});
        const work=await f.host.coordination!.create('lead',{title:'Shared work',idempotencyKey:'partial',assignments:[{agentId:'alice-agent',prompt:'own work'},{agentId:'bob-agent',prompt:'private work'}]});
        await f.host.coordination!.control.command('lead',work.id,{revision:work.revision,idempotencyKey:'private-wait',action:'wait',reason:'BOB_PRIVATE_REASON',question:'BOB_PRIVATE_QUESTION'});
        const result=await f.app.inject({url:'/v1/work/'+work.id,headers:{authorization:'Bearer '+await f.host.issueAccessToken('alice')}});
        expect(result.statusCode).toBe(200);expect(result.body).not.toContain('BOB_PRIVATE');expect(result.json().controlRestricted).toBe(true);
        expect((await f.host.coordination!.get('lead',work.id)).control.question).toBe('BOB_PRIVATE_QUESTION');
        await f.host.assistant!.runOnce();expect(JSON.stringify(await f.host.assistant!.inbox('lead'))).not.toContain('BOB_PRIVATE');
    }finally{await f.close();}
},30000);

test('a late executor receipt cannot overwrite human reconciliation or the old interrupted task',async()=>{
    let entered!:()=>void,release!:()=>void;const active=new Promise<void>(r=>entered=r),barrier=new Promise<void>(r=>release=r);let effects=0;
    const f=await fixture(async(request,host)=>{const action=await host.coordination.control.actions.execute(request,'late-effect',{},async()=>{effects++;entered();await barrier;return{receipt:'late executor value'};});return{id:randomUUID(),state:'succeeded',output:action.value.receipt};});
    try{
        await f.queue.startWorker();await active;await f.queue.recoverInterrupted();
        const record=await f.host.coordination!.control.status('lead',f.work.id);
        await f.host.coordination!.control.reconcile('lead',f.work.id,{revision:(await f.read()).revision,idempotencyKey:'closed-old-executor',reason:'Simulated fenced executor recovery; verified original effect',evidenceRefs:['fixture:fenced-receipt'],actions:[{actionId:record.actions[0]!.id,outcome:'succeeded',value:{receipt:'verified human value'}}],tasks:[{taskId:f.work.assignments[0]!.taskId,outcome:'closed'}]});
        release();await expect.poll(async()=>(await f.host.db.pool.query('SELECT state FROM work_action_attempts')).rows[0].state,{timeout:8000}).not.toBe('running');await new Promise(r=>setTimeout(r,150));
        const action=(await f.host.db.pool.query('SELECT state,data FROM work_actions')).rows[0];expect(action.data.value.receipt).toBe('verified human value');expect((await f.queue.get(f.work.assignments[0]!.taskId,'lead')).state).toBe('reconciliation_required');expect(effects).toBe(1);
    }finally{release();await f.close();}
},30000);

test('disabling a plugin prevents new execution but does not prevent validating its already admitted receipt',async()=>{
    const receipt={invocationId:randomUUID(),runId:randomUUID(),outcome:'succeeded',output:{text:'confirmed'},evidenceRefs:['fixture:confirmed']};
    const f=await fixture(async(request,host)=>{const action=await host.coordination.control.actions.execute(request,'@example/conformance:text.normalize@0.1.0',{text:'confirmed'},async()=>{await host.setPluginEnabled({principalId:'admin',pluginId:'@example/conformance',version:'0.1.0',enabled:false});return receipt;});return{id:randomUUID(),state:'succeeded',output:action.value.output.text};});
    try{
        await f.host.putActor({id:'admin',companyId:'one',role:'admin',permissions:[]});await f.queue.startWorker();
        await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('waiting_review');
        expect((await f.host.db.pool.query('SELECT state FROM work_actions')).rows[0].state).toBe('succeeded');expect(f.host.registry.list()[0]!.enabled).toBe(false);
    }finally{await f.close();}
},30000);

test('an independent reviewer can inspect and reconcile without gaining dispatch, stop or resume rights',async()=>{
    const f=await fixture(async(request,host)=>{await host.coordination.control.actions.execute(request,'external-effect',{},async()=>{throw Error('unknown effect');});return{id:randomUUID(),state:'succeeded'};});
    try{
        await f.queue.startWorker();await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('reconciliation_required');
        await f.host.putActor({id:'reviewer',companyId:'one',role:'employee',teamScope:'direct',permissions:['team.read','team.review']});
        const alice=await f.host.db.get<any>('actors','alice');await f.host.putActor({...alice,managerId:'reviewer'});
        const headers={authorization:'Bearer '+await f.host.issueAccessToken('reviewer')},current=await f.host.coordination!.get('reviewer',f.work.id);
        const ledger=await f.app.inject({url:'/v1/work/'+f.work.id+'/control',headers});expect(ledger.statusCode).toBe(200);expect(current.canReconcile).toBe(true);expect(current.canControl).toBe(false);
        for(const action of ['stop','resume']){const denied=await f.app.inject({method:'POST',url:'/v1/work/'+f.work.id+'/control',headers,payload:{revision:current.revision,idempotencyKey:'reviewer-'+action,action,reason:'no dispatch grant',assignments:[{agentId:'alice-agent',prompt:'continue'}]}});expect(denied.statusCode).toBe(403);}
        const result=await f.app.inject({method:'POST',url:'/v1/work/'+f.work.id+'/reconcile',headers,payload:{revision:current.revision,idempotencyKey:'reviewer-decision',reason:'Independent verification completed',evidenceRefs:['fixture:reviewed'],actions:[{actionId:ledger.json().actions[0].id,outcome:'not_executed'}],tasks:[{taskId:f.work.assignments[0]!.taskId,outcome:'closed'}]}});expect(result.statusCode).toBe(200);
    }finally{await f.close();}
},30000);

test('two unknown actions using the same tool expose their distinct inputs to the authorized reviewer',async()=>{
    let entered=0,release!:()=>void;const barrier=new Promise<void>(r=>release=r);
    const f=await fixture(async(request,host)=>{await Promise.allSettled(['first-target','second-target'].map(target=>host.coordination.control.actions.execute(request,'generic-external',{target},async()=>{if(++entered===2)release();await barrier;throw Error('unknown');})));return{id:randomUUID(),state:'reconciliation_required'};});
    try{
        await f.queue.startWorker();await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('reconciliation_required');
        const record=await f.host.coordination!.control.status('lead',f.work.id);expect(record.actions).toHaveLength(2);expect(new Set(record.actions.map(a=>a.input_preview)).size).toBe(2);
        const targets=[];for(const action of record.actions){const result=await f.app.inject({url:'/v1/work/'+f.work.id+'/actions/'+action.id,headers:f.headers});expect(result.statusCode).toBe(200);targets.push(result.json().input.target);expect(result.json().inputTruncated).toBe(false);}
        expect(targets.sort()).toEqual(['first-target','second-target']);
    }finally{release();await f.close();}
},30000);

test.each(['memory_write@host-1','@company/private-memory:notes.write@0.1.0'])('work action %s does not bypass the independent private-memory ACL',async(toolRef)=>{
    const f=await fixture(async(request,host)=>{const input={noteId:'PRIVATE',markdown:'PRIVATE_MEMORY_BODY_A2',expectedVersion:0,sourceRefs:['private:source']};await host.coordination.control.actions.execute(request,toolRef,input,async()=>{const note=await host.writeMemory({...input,principalId:request.principalId,agentId:request.agentId});return toolRef.startsWith('memory_write@')?note:{invocationId:randomUUID(),runId:randomUUID(),outcome:'succeeded',output:{noteId:note.noteId,version:note.version,markdown:note.markdown},evidenceRefs:['fixture:memory-result']};});return{id:randomUUID(),state:'succeeded',output:'Private note updated'};});
    try{
        if(toolRef.startsWith('@company/'))await f.host.installPlugin(resolve('packages/private-memory'));
        await f.queue.startWorker();await expect.poll(async()=>(await f.read()).state,{timeout:10000}).toBe('waiting_review');
        const ledger=await f.app.inject({url:'/v1/work/'+f.work.id+'/control',headers:f.headers});expect(ledger.body).not.toContain('PRIVATE_MEMORY_BODY_A2');
        const detail=await f.app.inject({url:'/v1/work/'+f.work.id+'/actions/'+ledger.json().actions[0].id,headers:f.headers});expect(detail.statusCode).toBe(200);expect(detail.body).not.toContain('PRIVATE_MEMORY_BODY_A2');expect(detail.json().inputRestricted).toBe(true);
        const lead=await f.host.db.get<any>('actors','lead');await f.host.putActor({...lead,permissions:[...lead.permissions,'agent.read:alice-agent','memory.read:alice-agent']});
        const permitted=await f.app.inject({url:'/v1/work/'+f.work.id+'/actions/'+ledger.json().actions[0].id,headers:f.headers});expect(permitted.body).toContain('PRIVATE_MEMORY_BODY_A2');
    }finally{await f.close();}
},30000);

