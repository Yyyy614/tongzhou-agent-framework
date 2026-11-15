import { listenHttp } from './helpers/http-server.js';
import{test,expect}from'vitest';import Fastify from'fastify';import{mkdir,mkdtemp,readFile}from'node:fs/promises';import{resolve}from'node:path';import{spawn}from'node:child_process';
test('the CLI logs in without exposing credentials and retains the exact mutation for an idempotent retry',async()=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data/entry-cli-')),config=resolve(root,'identity.json'),received:any[]=[];const app=Fastify();
    app.post('/a2/v1/employee/login',async request=>{expect((request.body as any).password).toBe('fixture-password');return{accessToken:'fixture-private-device-token',deviceId:'fixture-device',employee:{id:'alice'}};});
    app.get('/a2/v1/agents',async()=>[{id:'alice-agent',displayName:'My agent',active:true}]);
    app.post('/a2/v1/work',async request=>{expect(request.headers.authorization).toBe('Bearer fixture-private-device-token');received.push(request.body);return{id:'00000000-0000-4000-8000-000000000001',state:'queued'};});await listenHttp(app);
    const run=(args:string[],input='')=>new Promise<string>((ok,no)=>{const p=spawn(process.execPath,['scripts/agent-cli.mjs','--config',config,...args],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',errors='';p.stdout.on('data',d=>output+=String(d));p.stderr.on('data',d=>errors+=String(d));p.on('error',no);p.on('close',code=>code===0?ok(output):no(Error(errors.slice(-1000))));p.stdin.end(input);});
    try{
        const output=await run(['login','--server',app.listeningOrigin+'/a2','--username','alice','--password-stdin'],'fixture-password');expect(output).not.toContain('fixture-private');expect(output).not.toContain('fixture-password');
        expect(await run(['agents'])).toContain('My agent');
        await run(['work','create','--agent','alice-agent','--text','generic check','--key','one']);await run(['work','create','--agent','alice-agent','--text','generic check','--key','one']);expect(received).toHaveLength(2);expect(received[0]).toEqual(received[1]);
        if(process.platform==='win32')expect(await readFile(config,'utf8')).not.toContain('fixture-private-device-token');
    }finally{await app.close();}
},40000);
