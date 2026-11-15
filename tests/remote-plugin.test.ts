import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
test('a remote implementation mounts with the same manifest and scoped invocation envelope', async () => {
    const remote = Fastify();
    const calls: any[] = [];
    remote.post('/rpc', async (request) => { const rpc = request.body as any; calls.push(rpc); const result = rpc.method === 'plugin.initialize' ? { protocol: '1.0', tools: ['text.normalize'] } : rpc.method === 'tool.invoke' ? { text: rpc.params.input.text.trim() } : {}; return { jsonrpc: '2.0', id: rpc.id, result }; });
    await remote.listen({ host: '127.0.0.1', port: 0 });
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/remote-'));
    const host = await createFramework({ root, connections: { 'connection:fixture': { url: remote.listeningOrigin + '/rpc' } } });
    try {
        const source = resolve(root, 'source');
        await cp(resolve('fixtures/conformance-plugin'), source, { recursive: true });
        const manifest = JSON.parse(await readFile(resolve(source, 'agent-plugin.json'), 'utf8'));
        manifest.entry = { kind: 'remote', connectionRef: 'connection:fixture' };
        await writeFile(resolve(source, 'agent-plugin.json'), JSON.stringify(manifest));
        await host.installPlugin(source);
        await host.putActor({ id: 'alice', companyId: 'example', role: 'employee', permissions: ['tool.invoke:@example/conformance:text.normalize'] });
        await host.putAgent({ id: 'worker', ownerId: 'alice', companyId: 'example', pluginId: manifest.id, pluginVersion: manifest.version, allowedTools: ['@example/conformance:text.normalize'] });
        expect((await host.invoke({ principalId: 'alice', agentId: 'worker', toolRef: '@example/conformance:text.normalize', input: { text: ' ok ' }, idempotencyKey: 'one' })).output).toEqual({ text: 'ok' });
        const call = calls.find(c => c.method === 'tool.invoke');
        expect(call.params.context).toMatchObject({ principalId: 'alice', agentId: 'worker', companyId: 'example' });
        expect(call.params.idempotencyKey).toBeTruthy();
    }
    finally {
        await host.close();
        await remote.close();
    }
});

test('a managed private connection supplies credentials only to the remote adapter and rotates without reusing an old worker',async()=>{
    const remote=Fastify();const tokens:string[]=[],contexts:any[]=[];
    remote.post('/rpc',async request=>{const rpc=request.body as any;tokens.push(String(request.headers.authorization));if(rpc.method==='tool.invoke')contexts.push(rpc.params.context);return{jsonrpc:'2.0',id:rpc.id,result:rpc.method==='plugin.initialize'?{protocol:'1.0',tools:['text.normalize']}:rpc.method==='tool.invoke'?{text:rpc.params.input.text.trim()}:{}};});
    await remote.listen({host:'127.0.0.1',port:0});await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data/managed-remote-')),host=await createFramework({root});
    try{
        await host.putActor({id:'admin',companyId:'one',role:'admin',permissions:[]});for(const id of ['alice','bob'])await host.putActor({id,companyId:'one',role:'employee',permissions:['tool.invoke:@example/conformance:text.normalize']});
        const connection={id:'managed',name:'个人专用连接',kind:'plugin' as const,protocol:'company-jsonrpc' as const,provider:'fixture',baseURL:remote.listeningOrigin+'/rpc',accountGroup:'personal-test',maxConcurrency:1,priority:1,scope:'personal' as const,ownerId:'alice',enabled:true,documentation:'通用RPC测试',apiKey:'fixture-private-one'};
        await host.channels.save('admin',connection,true);
        const source=resolve(root,'source');await cp(resolve('fixtures/conformance-plugin'),source,{recursive:true});const manifest=JSON.parse(await readFile(resolve(source,'agent-plugin.json'),'utf8'));manifest.entry={kind:'remote',connectionRef:'connection:managed'};await writeFile(resolve(source,'agent-plugin.json'),JSON.stringify(manifest));await host.installPlugin(source);
        for(const ownerId of ['alice','bob'])await host.putAgent({id:ownerId+'-agent',ownerId,companyId:'one',pluginId:manifest.id,pluginVersion:manifest.version,allowedTools:['@example/conformance:text.normalize']});
        expect((await host.invoke({principalId:'alice',agentId:'alice-agent',toolRef:'@example/conformance:text.normalize',input:{text:' one '},idempotencyKey:'one'})).output).toEqual({text:'one'});
        await expect(host.invoke({principalId:'bob',agentId:'bob-agent',toolRef:'@example/conformance:text.normalize',input:{text:' forbidden '},idempotencyKey:'denied'})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
        const saved=(await host.channels.list('admin',true)).find(c=>c.id==='managed')!;await host.channels.save('admin',{...connection,apiKey:'fixture-private-two',revision:saved.revision},false);
        await host.invoke({principalId:'alice',agentId:'alice-agent',toolRef:'@example/conformance:text.normalize',input:{text:' two '},idempotencyKey:'two'});
        expect(tokens).toContain('Bearer fixture-private-one');expect(tokens).toContain('Bearer fixture-private-two');expect(JSON.stringify(contexts)).not.toContain('fixture-private');
    }finally{await host.close();await remote.close();}
});
