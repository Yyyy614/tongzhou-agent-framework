import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
test('the independent notes plugin reads only the invoking job and requires an explicit memory grant',async()=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data/private-notes-'));const host=await createFramework({root});
    try{
        await host.installPlugin('packages/private-memory');const tool='@company/private-memory:notes.read';
        await host.putActor({id:'alice',companyId:'one',role:'employee',permissions:['tool.invoke:'+tool,'memory.self.read']});
        await host.putAgent({id:'job',ownerId:'alice',companyId:'one',pluginId:'@company/private-memory',pluginVersion:'0.1.0',allowedTools:[tool],servicePermissions:['memory.self.read']});
        await host.writeMemory({principalId:'alice',agentId:'job',noteId:'INDEX',expectedVersion:0,markdown:'This job only.',sourceRefs:['test:notes']});
        expect((await host.invoke({principalId:'alice',agentId:'job',toolRef:tool,input:{noteId:'INDEX'},idempotencyKey:'read'})).output).toMatchObject({noteId:'INDEX',markdown:'This job only.',version:1});
        await host.putActor({id:'alice',companyId:'one',role:'employee',permissions:['tool.invoke:'+tool]});
        await expect(host.invoke({principalId:'alice',agentId:'job',toolRef:tool,input:{noteId:'INDEX'},idempotencyKey:'revoked'})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    }finally{await host.close();}
});
