import{test,expect}from'vitest';
import{spawn}from'node:child_process';
import{mkdir,mkdtemp,readFile}from'node:fs/promises';
import{resolve}from'node:path';
import{once}from'node:events';
import{pathToFileURL}from'node:url';
import{randomUUID}from'node:crypto';
import{createFramework}from'../src/index.js';
import{createServer}from'../src/server.js';
import{TaskQueue}from'../src/tasks.js';
import{HostLease}from'../src/host-lease.js';
import{testDatabase}from'./helpers/test-database.mjs';

test('a killed executor restarts fail-closed and human-confirmed external effects are not repeated',async()=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data/work-crash-'));
    const child=spawn(process.execPath,['--import',pathToFileURL(resolve('tests/helpers/source-hook.mjs')).href,resolve('tests/helpers/work-crash-worker.mjs'),root],{windowsHide:true,stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',d=>{errors=(errors+String(d)).slice(-1600);});
    let host:any,app:any,queue:any,lease:any;
    try{
        await expect.poll(async()=>{try{return JSON.parse(await readFile(resolve(root,'crash-ready.json'),'utf8'));}catch{if(child.exitCode!==null)throw Error('Crash fixture exited: '+errors);return null;}},{timeout:15000}).toBeTruthy();
        const original=JSON.parse(await readFile(resolve(root,'crash-ready.json'),'utf8'));
        const exited=once(child,'exit');child.kill('SIGKILL');await exited;
        const database=await testDatabase();
        host=await createFramework({root,database});lease=await HostLease.acquire(host.db);app=await createServer(host);let reused=false;
        queue=new TaskQueue(host,{async run(request:any){const result=await host.coordination.control.actions.execute(request,'external-effect',{operation:'one'},async()=>{throw Error('Must not replay external effect');});reused=result.reused;return{id:randomUUID(),state:'succeeded',output:result.value.receipt};}});
        await queue.open();queue.registerRoutes(app);await queue.recoverInterrupted();await queue.startWorker();
        const work=await host.coordination.get('lead',original.workId);expect(work.state).toBe('reconciliation_required');
        expect((await host.db.pool.query('SELECT state FROM work_action_attempts')).rows[0].state).toBe('unknown');
        await expect(host.coordination.control.command('lead',work.id,{revision:work.revision,idempotencyKey:'unsafe',action:'resume',reason:'should be blocked',assignments:[{agentId:'alice-agent',prompt:'continue'}]})).rejects.toMatchObject({code:'CONFLICT'});
        const actions=await host.coordination.control.status('lead',work.id);
        await host.coordination.control.reconcile('lead',work.id,{revision:work.revision,idempotencyKey:'verified',reason:'External file and terminated PID were verified',evidenceRefs:['fixture:external-effect.txt','fixture:process-exit'],actions:[{actionId:actions.actions[0].id,outcome:'succeeded',value:{receipt:'verified external effect'}}],tasks:[{taskId:original.taskId,outcome:'closed'}]});
        await host.coordination.control.command('lead',work.id,{revision:(await host.coordination.get('lead',work.id)).revision,idempotencyKey:'safe',action:'resume',reason:'External result verified, approve remaining work',assignments:[{agentId:'alice-agent',prompt:'use original receipt'}]});
        await expect.poll(async()=>(await host.coordination.get('lead',work.id)).state,{timeout:12000}).toBe('waiting_review');
        expect(reused).toBe(true);expect(await readFile(resolve(root,'external-effect.txt'),'utf8')).toBe('effect happened\n');
        expect((await queue.get(original.taskId,'lead')).state).toBe('reconciliation_required');
    }finally{if(child.exitCode===null)child.kill('SIGKILL');await queue?.close();await app?.close();await lease?.close();await host?.close();}
},40000);
