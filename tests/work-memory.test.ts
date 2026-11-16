import{test,expect}from'vitest';import{mkdir,mkdtemp}from'node:fs/promises';import{resolve}from'node:path';
import{createFramework}from'../src/index.js';import{createServer}from'../src/server.js';import{TaskQueue}from'../src/tasks.js';

test('work notes survive restart, stay separate by work and executor, and cannot overwrite host facts',async()=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data/work-memory-'));
    let host=await createFramework({root}),app=await createServer(host),queue=new TaskQueue(host,{async run(){throw Error('Do not execute while testing restored memory');}});
    await host.installPlugin(resolve('fixtures/conformance-plugin'));await host.putActor({id:'admin',companyId:'one',role:'admin',permissions:[]});
    for(const id of ['alice','bob']){await host.putActor({id,companyId:'one',role:'employee',permissions:[]});await host.putAgent({id:id+'-job',ownerId:id,companyId:'one',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});}
    await queue.open();queue.registerRoutes(app);
    try{
        const a=await host.coordination!.create('admin',{title:'Organize references',idempotencyKey:'a',assignments:[{agentId:'alice-job',prompt:'Organize'},{agentId:'bob-job',prompt:'Review own references'}]}),b=await host.coordination!.create('admin',{title:'Prepare handover',idempotencyKey:'b',assignments:[{agentId:'alice-job',prompt:'Prepare'}]});
        const alice={authorization:'Bearer '+await host.issueAccessToken('alice')},admin={authorization:'Bearer '+await host.issueAccessToken('admin')},bob={authorization:'Bearer '+await host.issueAccessToken('bob')};
        const note={expectedRevision:0,idempotencyKey:'save-a',goal:'Finish reference organization',decisions:[{text:'DECISION-ONLY-A',refs:[]}],blockers:[],nextSteps:[{text:'Review missing pages',refs:[]}],artifacts:[]};
        const url='/v1/work/'+a.id+'/memory/alice-job';
        const saved=await app.inject({url,method:'PUT',headers:alice,payload:note});expect(saved.statusCode).toBe(200);expect(saved.json().revision).toBe(1);expect(saved.json().facts.state).toBe('queued');
        expect((await app.inject({url,method:'PUT',headers:alice,payload:note})).json().revision).toBe(1);
        expect((await app.inject({url,method:'PUT',headers:alice,payload:{...note,idempotencyKey:'stale'}})).statusCode).toBe(409);
        expect((await app.inject({url,method:'PUT',headers:alice,payload:{...note,expectedRevision:1,idempotencyKey:'forge',facts:{state:'completed'}}})).statusCode).toBe(400);
        expect((await app.inject({url,headers:bob})).statusCode).toBe(403);
        expect((await app.inject({url,headers:admin})).body).not.toContain('DECISION-ONLY-A');
        const other=await app.inject({url:'/v1/work/'+b.id+'/memory/alice-job',headers:alice});expect(other.json().revision).toBe(0);expect(other.body).not.toContain('DECISION-ONLY-A');
        await host.workMemory.bind('alice','alice-job','native-session',a.id);
        expect(await host.workMemory.resolve('alice','alice-job',{entryKey:'native-session',continueWork:true})).toMatchObject({status:'resolved',workId:a.id});
        expect(await host.workMemory.resolve('alice','alice-job',{entryKey:'different-session',continueWork:true})).toMatchObject({status:'choose',candidates:expect.arrayContaining([expect.objectContaining({id:a.id}),expect.objectContaining({id:b.id})])});
        await queue.close();await app.close();await host.close();
        host=await createFramework({root});app=await createServer(host);queue=new TaskQueue(host,{async run(){throw Error('Restoring must not replay actions');}});await queue.open();queue.registerRoutes(app);
        const restored=await host.workMemory.read('alice',a.id,'alice-job');expect(restored.note.decisions[0].text).toBe('DECISION-ONLY-A');expect(restored.facts.state).toBe('queued');
        expect(await host.workMemory.resolve('alice','alice-job',{entryKey:'native-session',continueWork:true})).toMatchObject({status:'resolved',workId:a.id});
        expect((await host.db.pool.query('SELECT count(*)::int AS n FROM work_actions')).rows[0].n).toBe(0);
    }finally{await queue.close();await app.close();await host.close();}
});
