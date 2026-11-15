import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';

test('native workspace reads only active job context and forwards revisioned work actions without granting permissions',async()=>{
    const app=Fastify();const calls:any[]=[];
    app.post('/v1/employee/login',async()=>({accessToken:'fixture-device',deviceId:'device',employee:{id:'alice',companyId:'company'}}));
    app.get('/v1/employee/bootstrap',async()=>({employee:{id:'alice',companyId:'company'},agents:[{id:'a'},{id:'b'}]}));
    app.get('/v1/presets',async()=>[{id:'worker',version:'0.1.0'}]);
    app.post('/v1/harness/clients',async req=>({id:'lease',agentId:(req.body as any).agentId,token:'private-lease',preset:{id:'worker',version:'0.1.0'}}));
    app.get('/v1/harness/clients/:id',async()=>({lastRun:null}));app.delete('/v1/harness/clients/:id',async()=>({closed:true}));
    app.get('/v1/agents',async()=>[{id:'a',displayName:'A',allowedTools:['text.check']},{id:'b'}]);
    app.get('/v1/agents/:id/memory',async req=>{calls.push(req.url);return[{noteId:'INDEX',version:1}];});
    app.get('/v1/agents/:id/memory/:note',async req=>{calls.push(req.url);return{markdown:'own note'};});
    app.get('/v1/agents/:id/usage',async req=>{calls.push(req.url);return{totalTokens:10};});
    app.get('/v1/work/:id/history',async()=>[{kind:'created'}]);
    app.post('/v1/work/:id/control',async req=>{calls.push(req.body);return{revision:4};});
    app.post('/v1/work/:id/reconcile',async(_req,reply)=>reply.code(403).send({error:{code:'PERMISSION_DENIED',message:'Not authorized'}}));
    await app.listen({host:'127.0.0.1',port:0});await mkdir('.test-data',{recursive:true});
    const {createCompanySession}=await import('../client/company-session.mjs');
    const session=await createCompanySession({serverURL:app.listeningOrigin,dataDir:await mkdtemp(resolve('.test-data/company-studio-')),protection:{encrypt:async(v:string)=>v,decrypt:async(v:string)=>v},runtime:{start:async()=>{},stop:async()=>{}}});
    try{
        await session.login({username:'alice',password:'fixture-password',deviceName:'studio'});
        await expect(session.action('memory-list','current')).rejects.toMatchObject({code:'JOB_REQUIRED'});
        await session.selectAgent('a');
        expect(await session.action('memory-list','current',{agentId:'b'})).toHaveLength(1);
        expect(await session.action('memory-read','INDEX',{agentId:'b'})).toMatchObject({markdown:'own note'});
        expect(await session.action('job-details','current')).toMatchObject({id:'a',allowedTools:['text.check']});
        await session.action('job-usage','current');
        const control={action:'wait',revision:3,idempotencyKey:'stable-action',reason:'Review first'};
        expect(await session.action('work-control','work1',control)).toMatchObject({revision:4});
        expect(calls).toContainEqual(control);expect(calls).toContain('/v1/agents/a/memory');expect(calls).not.toContain('/v1/agents/b/memory');
        expect(await session.action('work-history','work1')).toHaveLength(1);
        await expect(session.action('work-reconcile','work1',{})).rejects.toMatchObject({status:403});
        await expect(session.action('arbitrary-url','current')).rejects.toMatchObject({code:'INVALID_INPUT'});
        await session.selectAgent('b');await session.action('memory-list','current');expect(calls).toContain('/v1/agents/b/memory');
    }finally{await session.close();await app.close();}
});
