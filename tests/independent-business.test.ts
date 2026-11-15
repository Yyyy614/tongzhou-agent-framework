import { test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';

async function kernelDigest() {
    const hash = createHash('sha256');
    async function add(path: string) { for (const file of (await readdir(path, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) { const next = resolve(path,file.name); if(file.isDirectory()) await add(next); else {hash.update(next);hash.update(await readFile(next));} } }
    await add(resolve('src')); return hash.digest('hex');
}

test('two separately authored business packages replace each other through public configuration while the kernel stays unchanged', async () => {
    const before = await kernelDigest();
    await mkdir('.test-data', { recursive: true });
    const directory = await mkdtemp(resolve('.test-data/business-swap-'));
    const host = await createFramework({ root: resolve(directory,'host') });
    try {
        const docs = resolve(directory,'independent-documents'), stock = resolve(directory,'independent-inventory');
        await cp('examples/plugins/document-check',docs,{recursive:true});
        await cp('examples/plugins/inventory-check',stock,{recursive:true});
        await host.installPlugin(docs); await host.installPlugin(stock);
        const documents='@independent/document-check:document.check', inventory='@independent/inventory-check:inventory.compare';
        await host.putActor({id:'employee',companyId:'new-company',role:'employee',permissions:['tool.invoke:'+documents,'tool.invoke:'+inventory]});
        await host.putAgent({id:'job',ownerId:'employee',companyId:'new-company',pluginId:'@independent/document-check',pluginVersion:'0.1.0',allowedTools:[documents]});
        const call=(toolRef:string,input:unknown,key:string)=>host.invoke({principalId:'employee',agentId:'job',toolRef,input,idempotencyKey:key});
        expect((await call(documents,{text:'合同包括交付时间与联系人',requiredTerms:['交付时间','付款方式']},'document-one')).output).toEqual({complete:false,missingTerms:['付款方式']});
        await host.writeMemory({principalId:'employee',agentId:'job',noteId:'INDEX',expectedVersion:0,markdown:'Keep this job history during capability changes.',sourceRefs:['test:independent-plugin']});
        await host.putAgent({id:'job',ownerId:'employee',companyId:'new-company',pluginId:'@independent/inventory-check',pluginVersion:'0.1.0',allowedTools:[inventory]});
        await expect(call(documents,{text:'old tool',requiredTerms:[]},'old-denied')).rejects.toMatchObject({code:'PERMISSION_DENIED'});
        expect((await call(inventory,{items:[{sku:'A',expected:10,actual:8},{sku:'B',expected:4,actual:4}]},'inventory-one')).output).toEqual({matched:1,differences:[{sku:'A',delta:-2}]});
        expect((await host.readMemory({principalId:'employee',agentId:'job',noteId:'INDEX'})).version).toBe(1);
        // Independently publish a new package version and bind it through the release API.
        const next=resolve(directory,'inventory-next');await cp(stock,next,{recursive:true});
        const manifest=JSON.parse(await readFile(resolve(next,'agent-plugin.json'),'utf8'));manifest.version='0.1.1';await writeFile(resolve(next,'agent-plugin.json'),JSON.stringify(manifest));
        await host.installPlugin(next);
        await host.putActor({id:'admin',companyId:'new-company',role:'admin',permissions:[]});
        await host.releaseAgent({principalId:'admin',agentId:'job',pluginVersion:'0.1.1',reason:'Independent package upgrade acceptance'});
        expect((await call(inventory,{items:[]},'after-upgrade')).output).toEqual({matched:0,differences:[]});
        await host.releaseAgent({principalId:'admin',agentId:'job',pluginVersion:'0.1.0',reason:'Independent package rollback acceptance'});
        expect((await host.db.get<any>('agents','job')).pluginVersion).toBe('0.1.0');
        await host.putActor({id:'outsider',companyId:'new-company',role:'employee',permissions:[]});
        await expect(host.readMemory({principalId:'outsider',agentId:'job',noteId:'INDEX'})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
        expect((await host.listLogs({principalId:'employee',agentId:'job'})).some((r:any)=>r.type==='tool.succeeded')).toBe(true);
        expect(await kernelDigest()).toBe(before);
    } finally { await host.close(); }
});
