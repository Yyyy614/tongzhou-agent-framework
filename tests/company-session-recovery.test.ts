import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCompanySession } from '../client/company-session.mjs';

async function fixture(){
    const backend=Fastify();const leases=new Set<string>(),owners=new Map<string,string>();let serial=0,presetFailure=false,releaseFailure=false,expiredAlice=false,readBarrier:Promise<void>|undefined;
    const owner=(request:any)=>String(request.headers.authorization).split('fixture-device-')[1];
    backend.post('/v1/employee/login',async request=>{const id=(request.body as any).username;return{accessToken:'fixture-device-'+id,deviceId:'device',employee:{id,companyId:'company'}};});
    backend.post('/v1/employee/logout',async()=>({signedOut:true}));
    backend.get('/v1/employee/bootstrap',async(request,reply)=>expiredAlice&&owner(request)==='alice'?reply.code(401).send({error:{code:'UNAUTHENTICATED'}}):{employee:{id:owner(request),companyId:'company'},agents:[{id:'job'}]});
    backend.get('/v1/presets',async(_request,reply)=>presetFailure?reply.code(503).send({error:{code:'UNAVAILABLE'}}):[{id:'worker',version:'0.1.0'}]);
    backend.post('/v1/harness/clients',async request=>{const id='lease-'+(++serial);leases.add(id);owners.set(id,owner(request));return{id,agentId:'job',token:'fixture-connection',preset:{id:'worker',version:'0.1.0'}};});
    backend.get('/v1/harness/clients/:id',async()=>({lastRun:null}));
    backend.delete('/v1/harness/clients/:id',async(request,reply)=>{const id=(request.params as any).id;if(expiredAlice&&owner(request)==='alice')return reply.code(401).send({error:{code:'UNAUTHENTICATED'}});if(owners.get(id)!==owner(request))return reply.code(403).send({error:{code:'PERMISSION_DENIED'}});if(releaseFailure)return reply.code(503).send({error:{code:'UNAVAILABLE'}});leases.delete(id);return{closed:true};});
    backend.get('/v1/work',async()=>{await readBarrier;return{items:[]};});
    for(const path of ['/v1/assistant/inbox','/v1/assistant/reminders','/v1/connections'])backend.get(path,async()=>({items:[]}));
    await backend.listen({host:'127.0.0.1',port:0});await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data/company-recovery-'));
    let starts=0,stops=0,alive=false;const runtime={start:async()=>{starts++;alive=true;},stop:async()=>{stops++;alive=false;},isReady:()=>alive};
    const options={serverURL:backend.listeningOrigin,dataDir:root,protection:{encrypt:async(v:string)=>Buffer.from(v).toString('base64'),decrypt:async(v:string)=>Buffer.from(v,'base64').toString()},runtime};
    const session=await createCompanySession(options);await session.login({username:'alice',password:'fixture',deviceName:'test'});
    return{session,options,root,leases,runtime,backend,setExpiredAlice:(v:boolean)=>{expiredAlice=v;},setPresetFailure:(v:boolean)=>{presetFailure=v;},setReleaseFailure:(v:boolean)=>{releaseFailure=v;},setReadBarrier:(v:Promise<void>)=>{readBarrier=v;},crash:()=>{alive=false;},counts:()=>({starts,stops}),close:async()=>{releaseFailure=false;expiredAlice=false;await session.close();await backend.close();}};
}
test('a preset lookup failure releases every newly acquired connection',async()=>{
    const f=await fixture();try{f.setPresetFailure(true);for(let i=0;i<3;i++)await expect(f.session.selectAgent('job')).rejects.toMatchObject({code:'UNAVAILABLE'});expect(f.leases.size).toBe(0);expect(f.counts().starts).toBe(0);}finally{await f.close();}
});
test('re-entering a job restarts a failed owned Host instead of reporting an unavailable workspace as ready',async()=>{
    const f=await fixture();try{await f.session.selectAgent('job');f.crash();expect((await f.session.state()).runtimeReady).toBe(false);await f.session.selectAgent('job');expect(f.counts().starts).toBe(2);expect(f.leases.size).toBe(1);}finally{await f.close();}
});
test('offline quit stops the local Host and persists remote cleanup for the next device session',async()=>{
    const f=await fixture();try{await f.session.selectAgent('job');f.setReleaseFailure(true);await f.session.close();expect(f.counts().stops).toBe(1);expect(f.leases.size).toBe(1);expect(JSON.parse(await readFile(resolve(f.root,'pending-releases.json'),'utf8')).releases).toEqual([{id:'lease-1',ownerId:'alice',companyId:'company'}]);f.setReleaseFailure(false);const next=await createCompanySession(f.options);try{expect((await next.state()).authenticated).toBe(true);expect(f.leases.size).toBe(0);}finally{await next.close();}}finally{await f.close();}
});
test('account state waits for an in-flight work-center read rather than falsely requiring another login',async()=>{
    const f=await fixture();let release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});f.setReadBarrier(barrier);
    let work:Promise<unknown>|undefined;
    try{work=f.session.workCenter();await Promise.resolve();const state=f.session.state();const observed=state.catch(()=>{});release();await work;expect((await state).authenticated).toBe(true);await observed;}finally{release();await work?.catch(()=>{});await f.close();}
});
test('pending connection cleanup remains owned by its employee and cannot block another account on the same computer',async()=>{
    const f=await fixture();let next:any;
    try{
        await f.session.selectAgent('job');f.setReleaseFailure(true);await f.session.close();f.setReleaseFailure(false);f.setExpiredAlice(true);
        next=await createCompanySession(f.options);expect((await next.state()).authenticated).toBe(false);
        const bob=await next.login({username:'bob',password:'fixture',deviceName:'test'});expect(bob.employee.id).toBe('bob');expect((await next.state()).authenticated).toBe(true);expect(f.leases.size).toBe(1);
        await next.logout();f.setExpiredAlice(false);await next.login({username:'alice',password:'fixture',deviceName:'test'});expect(f.leases.size).toBe(0);
    }finally{f.setReleaseFailure(false);f.setExpiredAlice(false);await next?.close();await f.close();}
});
