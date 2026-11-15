import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
test('the console reads scoped memory, actual audit, schema catalog and measured usage from the kernel', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/admin-observe-')) });
    const app = await createServer(host);
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        for (const [id, companyId] of [['admin', 'one'], ['foreign', 'two']])
            await host.putActor({ id: id!, companyId: companyId!, role: 'admin', permissions: [] });
        for (const [id, ownerId, companyId] of [['own', 'admin', 'one'], ['other', 'foreign', 'two']])
            await host.putAgent({ id: id!, ownerId: ownerId!, companyId: companyId!, pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        await host.writeMemory({ principalId: 'admin', agentId: 'own', noteId: 'INDEX', markdown: 'Only my index [[details]]', expectedVersion: 0, sourceRefs: ['test'] });
        for (const agentId of ['own', 'other'])
            await host.db.pool.query('INSERT INTO usage(id,run_id,data) VALUES($1,$2,$3)', [randomUUID(), randomUUID(), JSON.stringify({ agentId, principalId: agentId === 'own' ? 'admin' : 'foreign', inputTokens: 100, outputTokens: 20, measurement: 'provider', provider: 'test' })]);
        await host.db.audit('test.visible', { agentId: 'own', principalId: 'admin' });
        await host.db.audit('test.hidden', { agentId: 'other', principalId: 'foreign' });
        const headers = { authorization: 'Bearer ' + await host.issueAccessToken('admin') };
        const catalog = await app.inject({ url: '/v1/admin/plugins', headers });
        expect(catalog.statusCode).toBe(200);
        expect(catalog.json()[0].tools[0].inputSchema.type).toBe('object');
        const notes = await app.inject({ url: '/v1/agents/own/memory', headers });
        expect(notes.statusCode).toBe(200);
        expect(notes.json()[0]).toMatchObject({ noteId: 'INDEX', version: 1 });
        expect(notes.json()[0].links).toContain('details');
        expect((await app.inject({ url: '/v1/agents/other/memory', headers })).statusCode).toBe(403);
        const usage = (await app.inject({ url: '/v1/admin/usage?days=7', headers })).json();
        expect(usage.totals).toMatchObject({ requests: 1, inputTokens: 100, outputTokens: 20 });
        expect(usage.byEmployee[0].principalId).toBe('admin');
        expect(usage.series).toHaveLength(7);
        const logs = (await app.inject({ url: '/v1/admin/activity?q=test.', headers })).json();
        expect(logs.items.map((l: any) => l.type)).toContain('test.visible');
        expect(logs.items.map((l: any) => l.type)).not.toContain('test.hidden');
        expect((await app.inject({method:'POST',url:'/v1/plugins/install',headers,payload:{path:resolve('fixtures/conformance-plugin')}})).statusCode).toBe(200);
        const installation=(await app.inject({url:'/v1/admin/activity?q=plugin.installed',headers})).json();
        expect(installation.items.some((e:any)=>e.data.principalId==='admin'&&e.data.companyId==='one')).toBe(true);
        await host.db.pool.query("INSERT INTO audit(id,type,data) SELECT gen_random_uuid(),'pagination-probe',jsonb_build_object('agentId','own','principalId','admin') FROM generate_series(1,105)");
        const firstPage=(await app.inject({url:'/v1/admin/activity?q=pagination-probe',headers})).json();expect(firstPage.items).toHaveLength(100);expect(firstPage.nextCursor).toBeTruthy();
        const secondPage=(await app.inject({url:'/v1/admin/activity?q=pagination-probe&before='+firstPage.nextCursor,headers})).json();expect(secondPage.items).toHaveLength(5);expect(secondPage.nextCursor).toBe(null);expect(secondPage.items.some((e:any)=>firstPage.items.some((p:any)=>p.id===e.id))).toBe(false);
        const overview = (await app.inject({ url: '/v1/admin/overview', headers })).json();
        expect(overview.counts).toMatchObject({ employees: 1, agents: 1 });
    }
    finally {
        await app.close();
        await host.close();
    }
});
