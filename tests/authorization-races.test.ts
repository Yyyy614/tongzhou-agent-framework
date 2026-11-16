import{test,expect}from'vitest';import{mkdir,mkdtemp}from'node:fs/promises';import{resolve}from'node:path';import{createFramework}from'../src/index.js';
test('queued domain configuration rechecks administrator authorization after a role withdrawal',async()=>{
 await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/standards-domain-')),resourceWorker:false});let gate:any;
 try{await host.putActor({id:'admin',companyId:'one',role:'admin',permissions:[]});const actor=await host.db.get<any>('actors','admin');gate=await host.db.pool.connect();await gate.query('BEGIN');await host.organization.lock(gate);
  const waiting=async()=>Number((await host.db.pool.query("SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND granted=false AND objid=(hashtext($1)::bigint & 4294967295)",[host.db.schema+':organization'])).rows[0].n);
  const revoke=host.putActor({...actor,role:'employee'});await expect.poll(waiting).toBe(1);
  const configured=host.knowledge.configure('admin','guides',{name:'Changed after revoke',description:'Scope',source:'database'});await expect.poll(waiting).toBe(2);
  await gate.query('COMMIT');gate.release();gate=null;await revoke;
  await expect(configured).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 }finally{if(gate){await gate.query('ROLLBACK');gate.release();}await host.close();}
});
test('a reassigned job can subscribe for its current owner',async()=>{
 await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/standards-subscription-')),resourceWorker:false});
 try{await host.installPlugin(resolve('fixtures/conformance-plugin'));for(const id of ['alice','bob','admin'])await host.putActor({id,companyId:'one',role:id==='admin'?'admin':'employee',permissions:[]});
  await host.putAgent({id:'job',companyId:'one',ownerId:'alice',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});const source=await host.resources.create('admin',{title:'Shared',kind:'document',domain:'guides',body:'first',access:{scope:'company',readerIds:[]},idempotencyKey:'one'});
  await host.resourceIndex.subscribe('alice','job',{resourceId:source.id,mode:'notify'});const job=await host.db.get<any>('agents','job');await host.putAgent({...job,ownerId:'bob'});await host.resourceIndex.subscribe('bob','job',{resourceId:source.id,mode:'notify'});
  await host.resources.update('admin',source.id,{revision:source.revision,body:'second'});await host.resourceIndex.process();expect((await host.resourceIndex.notifications('bob','job')).items).toHaveLength(1);
 }finally{await host.close();}
});
