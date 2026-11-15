import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';

test('resource indexes and ContextPacks enforce current ACL, immutable versions and a real content budget', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/resources-')) });
    let app: any;
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        for (const [id, role, companyId] of [['alice', 'employee', 'one'], ['bob', 'employee', 'one'], ['admin', 'admin', 'one'], ['outside', 'admin', 'two']] as const)
            await host.putActor({ id, role, companyId, permissions: [] });
        await host.putAgent({ id: 'alice-job', ownerId: 'alice', companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        app = await createServer(host);
        const headers: Record<string, any> = {};
        for (const id of ['alice', 'bob', 'admin', 'outside']) headers[id] = { authorization: 'Bearer ' + await host.issueAccessToken(id) };
        const api = (actor: string, url: string, method: any = 'GET', payload?: unknown) => app.inject({ url, method, payload, headers: headers[actor] });
        const create = await api('alice', '/v1/resources', 'POST', { title: 'Private evidence', kind: 'document', domain: 'validation', body: 'private-resource-needle '.repeat(300), access: { scope: 'personal', readerIds: [] }, idempotencyKey: 'create-one' });
        expect(create.statusCode).toBe(201);
        const resource = create.json();
        expect(resource.version).toBe(1); expect(resource.digest).toMatch(/^[a-f0-9]{64}$/u);
        for (const actor of ['bob', 'admin', 'outside']) {
            expect((await api(actor, '/v1/resources/' + resource.id)).statusCode).toBe(404);
            expect((await api(actor, '/v1/resources?query=private-resource-needle')).json().items).toEqual([]);
        }
        const pack = await api('alice', '/v1/agents/alice-job/context-packs', 'POST', { resources: [{ id: resource.id, version: 1 }], maxChars: 1200 });
        expect(pack.statusCode).toBe(201);
        expect(pack.json().modelContext.length).toBeLessThanOrEqual(1200);
        expect(pack.json().truncated).toBe(true);
        expect(pack.json().sources[0]).toMatchObject({ id: resource.id, version: 1, digest: resource.digest });
        expect((await api('bob', '/v1/agents/alice-job/context-packs', 'POST', { resources: [{ id: resource.id, version: 1 }], maxChars: 1200 })).statusCode).toBe(403);
        const shared = await api('alice', '/v1/resources/' + resource.id + '/access', 'PUT', { revision: resource.revision, access: { scope: 'personal', readerIds: ['bob'] } });
        expect(shared.statusCode).toBe(200);
        expect((await api('bob', '/v1/resources?query=private-resource-needle')).json().items[0].id).toBe(resource.id);
        const next = await api('alice', '/v1/resources/' + resource.id + '/versions', 'POST', { revision: shared.json().revision, body: 'updated evidence', sourceRefs: [] });
        expect(next.statusCode).toBe(201); expect(next.json().version).toBe(2);
        expect((await api('alice', '/v1/resources/' + resource.id + '/versions', 'POST', { revision: resource.revision, body: 'stale update', sourceRefs: [] })).statusCode).toBe(409);
        expect((await api('alice', '/v1/context-packs/' + pack.json().id)).statusCode).toBe(409);
        const second = await api('alice', '/v1/agents/alice-job/context-packs', 'POST', { resources: [{ id: resource.id, version: 2 }], maxChars: 1200 });
        expect(second.statusCode).toBe(201); expect(second.json().modelContext).toContain('updated evidence');
        const revoked = await api('alice', '/v1/resources/' + resource.id + '/access', 'PUT', { revision: next.json().revision, access: { scope: 'personal', readerIds: [] } });
        expect(revoked.statusCode).toBe(200);
        expect((await api('bob', '/v1/resources/' + resource.id)).statusCode).toBe(404);
        expect((await api('bob', '/v1/resources?query=updated')).json().items).toEqual([]);
        const restored = await api('alice', '/v1/resources/' + resource.id + '/access', 'PUT', { revision: revoked.json().revision, access: { scope: 'personal', readerIds: ['bob'] } });
        expect(restored.statusCode).toBe(200);
        expect((await api('alice', '/v1/context-packs/' + second.json().id)).statusCode).toBe(409);
        expect((await api('alice', '/v1/resources/' + resource.id + '?version=invalid')).statusCode).toBe(400);
    } finally { await app?.close(); await host.close(); }
});
