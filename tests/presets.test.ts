import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';

test('a pinned role preset is configurable through management and never grants authority', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/presets-')) });
    const app = await createServer(host);
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'admin', companyId: 'one', role: 'admin', permissions: [] });
        await host.putActor({ id: 'alice', companyId: 'one', role: 'employee', permissions: [] });
        await host.putActor({ id: 'bob', companyId: 'one', role: 'employee', permissions: [] });
        const headers = { authorization: 'Bearer ' + await host.issueAccessToken('admin') };
        const catalog = (await app.inject({ url: '/v1/presets', headers })).json();
        expect(catalog.map((p: any) => p.level)).toEqual(['worker', 'lead', 'coordinator']);
        expect((await app.inject({ url: '/v1/presets' })).statusCode).toBe(401);
        const base = { id: 'worker', ownerId: 'alice', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [], preset: { id: 'company-coordinator', version: '0.1.0' } };
        const saved = await app.inject({ method: 'POST', url: '/v1/admin/agents', headers, payload: base });
        expect(saved.statusCode).toBe(201);
        expect(saved.json().preset).toEqual(base.preset);
        const owner = await host.db.get<any>('actors', 'alice');
        expect(owner.permissions).toEqual([]);
        await host.putAgent({ ...base, id: 'other', ownerId: 'bob', companyId: 'one' });
        await expect(host.authorize('alice', 'other', 'read')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        await expect(host.invoke({ principalId: 'alice', agentId: 'worker', toolRef: '@example/conformance:text.normalize', input: { text: 'x' }, idempotencyKey: 'no-implicit-tools' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        const unknown = await app.inject({ method: 'POST', url: '/v1/admin/agents', headers, payload: { ...base, id: 'unknown', preset: { id: 'company-worker', version: '9.0.0' } } });
        expect(unknown.statusCode).toBe(404);
        const employeeHeaders = { authorization: 'Bearer ' + await host.issueAccessToken('alice') };
        expect((await app.inject({ method: 'POST', url: '/v1/admin/agents', headers: employeeHeaders, payload: { ...base, id: 'self-elevate' } })).statusCode).toBe(403);
    } finally { await app.close(); await host.close(); }
});
