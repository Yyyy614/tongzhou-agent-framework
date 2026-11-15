import { test, expect } from 'vitest';
import { mkdir,mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer as createHTTP } from 'node:http';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { HarnessRuntime } from '../src/runtime.js';
test('a model response whose usage cannot be persisted stays pending reconciliation rather than an ordinary retryable failure',async()=>{
    await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/model-accounting-'))}),app=await createServer(host);
    const upstream=createHTTP((req,res)=>{res.setHeader('content-type','application/json');res.end('{"usage":{"input_tokens":1,"output_tokens":1},"content":[]}');});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
    const runtime=new HarnessRuntime(app,host,{apiKey:'fixture-model-credential',upstreamURL:'http://127.0.0.1:'+(upstream.address() as any).port,model:'fixture-model'});
    const query=host.db.pool.query.bind(host.db.pool);
    try{
        await host.installPlugin(resolve('fixtures/conformance-plugin'));await host.putActor({id:'u',companyId:'one',role:'employee',permissions:[]});await host.putAgent({id:'u-agent',ownerId:'u',companyId:'one',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});
        const turn=await runtime.openClientTurn({principalId:'u',agentId:'u-agent',prompt:'fixture',idempotencyKey:'accounting'});
        (host.db.pool as any).query=(sql:any,...values:any[])=>typeof sql==='string'&&sql.startsWith('INSERT INTO usage')?Promise.reject(Error('fixture ledger unavailable')):query(sql,...values as []);
        const response=await app.inject({method:'POST',url:'/internal/model/'+turn.id+'/v1/messages',headers:{'x-api-key':turn.token},payload:{model:'fixture-model',messages:[],max_tokens:1,tools:[]}});
        (host.db.pool as any).query=query;
        expect(response.statusCode).toBe(409);expect(response.json().error.code).toBe('RESULT_UNKNOWN');
        await runtime.finishClientTurn(turn.id,'','CLIENT_ERROR');expect((await runtime.get(turn.id,'u')).state).toBe('reconciliation_required');
    }finally{(host.db.pool as any).query=query;await runtime.close();await app.close();await host.close();await new Promise<void>(r=>upstream.close(()=>r()));}
});
