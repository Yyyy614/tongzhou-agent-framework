import{test,expect}from'vitest';import{mkdir,mkdtemp}from'node:fs/promises';import{resolve}from'node:path';
import{createFramework}from'../src/index.js';import{createServer}from'../src/server.js';import{TaskQueue}from'../src/tasks.js';

async function fixture(){await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/source-boundaries-'))});await host.installPlugin(resolve('fixtures/conformance-plugin'));for(const id of ['alice','bob'])await host.putActor({id,companyId:'one',role:'employee',permissions:[]});await host.putActor({id:'admin',companyId:'one',role:'admin',permissions:[]});await host.putAgent({id:'job',ownerId:'alice',companyId:'one',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});return host;}

test('concurrent derived reads use their transaction connection without starving the pool',async()=>{
    const host=await fixture();try{const source=await host.resources.create('bob',{title:'Shared source',kind:'document',domain:'work-process',body:'source',access:{scope:'personal',readerIds:['alice']},idempotencyKey:'source'});const derived=await host.resources.create('alice',{title:'Derived',kind:'artifact',domain:'validation',body:'derived',access:{scope:'personal',readerIds:[]},idempotencyKey:'derived'},{sources:await host.provenance.resourceOrigins(source)});
        const results=await Promise.allSettled(Array.from({length:8},()=>host.resources.read('alice',derived.id)));expect(results.every(r=>r.status==='fulfilled')).toBe(true);
    }finally{await host.close();}
},15000);

test('regranting a root source cannot revive an old derived ContextPack',async()=>{
    const host=await fixture();try{const source=await host.resources.create('bob',{title:'Shared source',kind:'document',domain:'work-process',body:'source',access:{scope:'personal',readerIds:['alice']},idempotencyKey:'source'});const derived=await host.resources.create('alice',{title:'Derived',kind:'artifact',domain:'validation',body:'derived',access:{scope:'personal',readerIds:[]},idempotencyKey:'derived'},{sources:await host.provenance.resourceOrigins(source)});const pack=await host.resources.context('alice','job',{resources:[{id:derived.id,version:1}]});
        const revoked=await host.resources.update('bob',source.id,{revision:source.revision,access:{scope:'personal',readerIds:[]}});await host.resources.update('bob',source.id,{revision:revoked.revision,access:{scope:'personal',readerIds:['alice']}});
        await expect(host.resources.pack('alice',pack.id)).rejects.toMatchObject({code:'CONFLICT'});
    }finally{await host.close();}
});

test('notes cannot drop inherited origins and work-memory origins follow current executor authorization',async()=>{
    const host=await fixture(),app=await createServer(host),queue=new TaskQueue(host,{async run(){throw Error('Do not run');}});try{await queue.open();queue.registerRoutes(app);
        const work=await host.coordination!.create('admin',{title:'Generic work',idempotencyKey:'one',assignments:[{agentId:'job',prompt:'Organize'}]}),source=await host.resources.create('bob',{title:'Shared source',kind:'document',domain:'validation',body:'PRIVATE-SOURCE',access:{scope:'personal',readerIds:['alice']},idempotencyKey:'source'});
        const note={goal:'Goal',decisions:[{text:'Private decision',refs:[{id:source.id,version:1}]}],blockers:[],nextSteps:[],artifacts:[],expectedRevision:0,idempotencyKey:'first'};await host.workMemory.save('alice',work.id,'job',note);
        const origin=await host.workMemory.origin('alice',work.id,'job');const derived=await host.resources.create('alice',{title:'Note-derived',kind:'artifact',domain:'validation',body:'private derived',access:{scope:'personal',readerIds:[]},idempotencyKey:'derived'},{sources:[origin!.ref,...origin!.sources]});
        const revoked=await host.resources.update('bob',source.id,{revision:source.revision,access:{scope:'personal',readerIds:[]}});
        await expect(host.workMemory.save('alice',work.id,'job',{...note,expectedRevision:1,idempotencyKey:'wash',decisions:[{text:'Private decision',refs:[]}]})).rejects.toMatchObject({code:'NOT_FOUND'});
        await host.resources.update('bob',source.id,{revision:revoked.revision,access:{scope:'personal',readerIds:['alice']}});
        const job=await host.db.get<any>('agents','job');await host.putAgent({...job,ownerId:'bob'});
        await expect(host.workMemory.read('alice',work.id,'job')).rejects.toMatchObject({code:'PERMISSION_DENIED'});await expect(host.resources.read('alice',derived.id)).rejects.toMatchObject({code:'NOT_FOUND'});
    }finally{await queue.close();await app.close();await host.close();}
});
