import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('one company application signs in, switches isolated Harness jobs and signs out without exposing device or model credentials', async () => {
    const backend=Fastify();let serial=0;const released:string[]=[];
    backend.post('/v1/employee/login',async request=>({accessToken:'device-secret-'+(request.body as any).username,deviceId:'device',expiresAt:'2099-01-01',employee:{id:(request.body as any).username,companyId:'company',displayName:'员工'}}));
    backend.get('/v1/employee/bootstrap',async request=>({employee:{id:String(request.headers.authorization).endsWith('alice')?'alice':'bob',companyId:'company',displayName:'员工'},agents:[{id:'documents',displayName:'资料核对',preset:{id:'employee',version:'0.1.0'}},{id:'inventory',displayName:'库存核对',preset:{id:'employee',version:'0.1.0'}}]}));
    backend.get('/v1/presets',async()=>[{id:'employee',version:'0.1.0',name:'员工'}]);
    backend.post('/v1/harness/clients',async request=>({id:'lease-'+(++serial),agentId:(request.body as any).agentId,token:'private-model-connection-'+serial,expiresAt:'2099-01-01',preset:{id:'employee',version:'0.1.0'}}));
    backend.get('/v1/harness/clients/:id',async()=>({lastRun:null}));
    backend.delete('/v1/harness/clients/:id',async request=>{released.push((request.params as any).id);return{closed:true};});
    backend.post('/v1/employee/logout',async()=>({signedOut:true}));
    await backend.listen({host:'127.0.0.1',port:0});await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data/company-session-'));
    const starts:any[]=[];let stopped=0;
    const runtime={start:async(config:any)=>{starts.push(config);},stop:async()=>{stopped++;}};
    const protection={encrypt:async(value:string)=>Buffer.from(value).toString('base64'),decrypt:async(value:string)=>Buffer.from(value,'base64').toString()};
    const {createCompanySession}=await import('../client/company-session.mjs');
    const session=await createCompanySession({serverURL:backend.listeningOrigin,dataDir:root,protection,runtime});
    try{
        expect((await session.state()).authenticated).toBe(false);
        await session.login({username:'alice',password:'never-save-password',deviceName:'isolated-test'});
        expect(JSON.stringify(await session.state())).not.toMatch(/device-secret|private-model|never-save-password/);
        expect(await readFile(resolve(root,'identity.json'),'utf8')).not.toMatch(/never-save-password|device-secret/);
        await session.selectAgent('documents');
        expect((await session.state()).activeAgentId).toBe('documents');
        await expect(session.selectAgent('unassigned')).rejects.toMatchObject({code:'PERMISSION_DENIED'});
        await session.selectAgent('inventory');
        expect((await session.state()).activeAgentId).toBe('inventory');
        expect(starts[0].home).not.toBe(starts[1].home);
        expect(released).toEqual(['lease-1']);expect(stopped).toBe(1);
        await session.logout();
        expect((await session.state()).authenticated).toBe(false);
        expect(released).toEqual(['lease-1','lease-2']);
        await session.login({username:'bob',password:'different-test-password',deviceName:'isolated-test'});
        await session.selectAgent('documents');
        expect(starts[2].home).not.toBe(starts[0].home);
        await session.logout();
    }finally{await session.close();await backend.close();}
});

test('switching jobs waits for confirmed teardown and a failed stop cannot start another Harness identity', async()=>{
    const backend=Fastify();let activeWork=false;let serial=0;
    backend.post('/v1/employee/login',async()=>({accessToken:'device-fixture',deviceId:'device',employee:{id:'alice',companyId:'company'}}));
    backend.get('/v1/employee/bootstrap',async()=>({employee:{id:'alice',companyId:'company'},agents:[{id:'a'},{id:'b'}]}));
    backend.get('/v1/presets',async()=>[{id:'employee',version:'0.1.0'}]);
    backend.post('/v1/harness/clients',async request=>({id:'lease-'+(++serial),agentId:(request.body as any).agentId,token:'lease-fixture',preset:{id:'employee',version:'0.1.0'}}));
    backend.get('/v1/harness/clients/:id',async()=>({lastRun:activeWork?{state:'running'}:null}));
    backend.delete('/v1/harness/clients/:id',async()=>({closed:true}));
    await backend.listen({host:'127.0.0.1',port:0});await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data/company-stop-'));
    let failedStop=true;const started:string[]=[];
    const {createCompanySession}=await import('../client/company-session.mjs');
    const session=await createCompanySession({serverURL:backend.listeningOrigin,dataDir:root,protection:{encrypt:async(v:string)=>v,decrypt:async(v:string)=>v},runtime:{start:async(c:any)=>{started.push(c.lease.agentId);},stop:async()=>{if(failedStop)throw Error('Exit not confirmed');}}});
    try{
        await session.login({username:'alice',password:'fixture-password',deviceName:'test'});await session.selectAgent('a');activeWork=true;
        await expect(session.selectAgent('b')).rejects.toMatchObject({code:'WORK_RUNNING'});
        await expect(session.selectAgent('b',{stopActive:true})).rejects.toThrow('Exit not confirmed');
        expect(started).toEqual(['a']);
        failedStop=false;activeWork=false;await session.selectAgent('b',{stopActive:true});
        expect(started).toEqual(['a','b']);
    }finally{failedStop=false;await session.close();await backend.close();}
});

test('quitting during Host startup drains that transition and rejects new identity operations',async()=>{
    const backend=Fastify();backend.post('/v1/employee/login',async()=>({accessToken:'fixture-device',deviceId:'device',employee:{id:'alice',companyId:'company'}}));
    backend.get('/v1/employee/bootstrap',async()=>({employee:{id:'alice',companyId:'company'},agents:[{id:'a'}]}));backend.get('/v1/presets',async()=>[{id:'worker',version:'0.1.0'}]);
    backend.post('/v1/harness/clients',async()=>({id:'lease',agentId:'a',token:'fixture-lease',preset:{id:'worker',version:'0.1.0'}}));backend.delete('/v1/harness/clients/:id',async()=>({closed:true}));
    await backend.listen({host:'127.0.0.1',port:0});await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data/company-drain-'));
    let started=false,stopped=false;let release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});
    const {createCompanySession}=await import('../client/company-session.mjs');const session=await createCompanySession({serverURL:backend.listeningOrigin,dataDir:root,protection:{encrypt:async(v:string)=>v,decrypt:async(v:string)=>v},runtime:{start:async()=>{started=true;await barrier;},stop:async()=>{stopped=true;}}});
    let switching:Promise<unknown>|undefined,closing:Promise<unknown>|undefined;
    try{
        await session.login({username:'alice',password:'fixture',deviceName:'test'});switching=session.selectAgent('a');await expect.poll(()=>started).toBe(true);
        closing=session.close();const observedClose=closing.catch(()=>{});
        await expect(session.state()).rejects.toMatchObject({code:'CLIENT_CLOSING'});
        expect(stopped).toBe(false);release();await switching;await closing;await observedClose;expect(stopped).toBe(true);
    }finally{release();await switching?.catch(()=>{});await closing?.catch(()=>{});await session.close();await backend.close();}
});
