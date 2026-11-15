import {test,expect} from 'vitest';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createFramework} from '../src/index.js';
import {createServer} from '../src/server.js';
import {TaskQueue} from '../src/tasks.js';

test('company webhook mappings are rechecked for pending routing and already queued work',async()=>{
    await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/event-authority-'))}),app=await createServer(host);let executed=0;
    const queue=new TaskQueue(host,{async run(){executed++;return{id:randomUUID(),state:'succeeded',output:'must not execute after revocation'};}});
    try{
        await host.installPlugin(resolve('fixtures/conformance-plugin'));for(const[id,role]of [['admin','admin'],['alice','employee'],['bob','employee']]as const)await host.putActor({id,role,companyId:'one',permissions:[]});
        await host.putAgent({id:'job',ownerId:'bob',companyId:'one',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});await queue.open();queue.registerRoutes(app);
        const headers={authorization:'Bearer '+await host.issueAccessToken('admin')},config={name:'Company webhook',enabled:true,mode:'execute',semantic:false,allowedPrincipalIds:['alice'],mappings:[{externalId:'external-alice',principalId:'alice'}],targets:[{agentId:'job',eventTypes:['request'],description:'Generic assigned work'}]};
        const source=(await app.inject({url:'/v1/admin/event-sources',method:'POST',headers,payload:config})).json();
        const send=(id:string,key=source.sourceKey)=>app.inject({url:'/v1/hooks/event-sources/'+source.id,method:'POST',headers:{authorization:'Bearer '+key},payload:{externalUserId:'external-alice',event:{externalEventId:id,threadId:id,eventType:'request',summary:'bounded input '+id}}});
        expect((await send('wrong','invalid')).statusCode).toBe(401);
        const first=await send('first');expect(first.statusCode).toBe(202);expect((await send('first')).json().id).toBe(first.json().id);
        await host.events.runOnce();const routed=await host.events.get('admin',first.json().id);expect(routed.state).toBe('routed');
        const pending=await send('pending');
        expect((await app.inject({url:'/v1/admin/event-sources/'+source.id,method:'PUT',headers,payload:{...config,mappings:[],revision:source.revision}})).statusCode).toBe(200);
        await host.events.runOnce();expect((await host.events.get('admin',pending.json().id)).state).toBe('blocked');
        await queue.startWorker();await expect.poll(async()=>(await host.coordination!.get('admin',routed.workId)).state,{timeout:10000}).toBe('needs_attention');expect(executed).toBe(0);
    }finally{await queue.close();await app.close();await host.close();}
});

test('a company source can subscribe to host events without creating a per-employee Bot rule',async()=>{
    await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/host-subscription-'))}),app=await createServer(host),queue=new TaskQueue(host,{async run(){return{id:randomUUID(),state:'succeeded',output:'bounded assistance'};}});
    try{
        await host.installPlugin(resolve('fixtures/conformance-plugin'));await host.putActor({id:'admin',companyId:'one',role:'admin',permissions:[]});await host.putActor({id:'alice',companyId:'one',role:'employee',permissions:[]});await host.putAgent({id:'job',ownerId:'alice',companyId:'one',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});await queue.open();queue.registerRoutes(app);
        const headers={authorization:'Bearer '+await host.issueAccessToken('admin')};
        const source=await app.inject({url:'/v1/admin/event-sources',method:'POST',headers,payload:{name:'Generic host subscription',enabled:true,mode:'execute',semantic:false,subscribeHostEvents:true,allowedPrincipalIds:['admin'],targets:[{agentId:'job',eventTypes:['validation.request'],description:'Generic assistance'}]}});expect(source.statusCode).toBe(201);
        const event=await host.assistant!.publishEvent('admin',{agentId:'job',type:'validation.request',summary:'An authorized host event',idempotencyKey:'one'});
        await host.events.runOnce();await host.events.runOnce();
        expect((await host.db.pool.query("SELECT count(*)::int AS n FROM company_events WHERE external_id=$1",['host:'+event.id])).rows[0].n).toBe(1);
        expect((await host.db.pool.query('SELECT count(*)::int AS n FROM work_items')).rows[0].n).toBe(1);
        expect((await host.db.pool.query('SELECT count(*)::int AS n FROM assistant_rules')).rows[0].n).toBe(0);
    }finally{await queue.close();await app.close();await host.close();}
});
