import { test, expect } from 'vitest';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
test('HTTP binds identity from a revocable token and refuses body-level identity spoofing', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/http-')) });
    const app = await createServer(host);
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        for (const id of ['alice', 'bob'])
            await host.putActor({ id, companyId: 'example', role: 'employee', permissions: ['tool.invoke:@example/conformance:text.normalize'] });
        await host.putAgent({ id: 'worker', ownerId: 'alice', companyId: 'example', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: ['@example/conformance:text.normalize'] });
        const body = { agentId: 'worker', toolRef: '@example/conformance:text.normalize', input: { text: ' hi ' }, idempotencyKey: 'one' };
        expect((await app.inject({ method: 'POST', url: '/v1/invoke', payload: body })).statusCode).toBe(401);
        const alice = await host.issueAccessToken('alice');
        const bob = await host.issueAccessToken('bob');
        const ok = await app.inject({ method: 'POST', url: '/v1/invoke', headers: { authorization: 'Bearer ' + alice }, payload: body });
        expect(ok.statusCode).toBe(200);
        expect(ok.json().output.text).toBe('hi');
        const denied = await app.inject({ method: 'POST', url: '/v1/invoke', headers: { authorization: 'Bearer ' + bob }, payload: { ...body, principalId: 'alice' } });
        expect(denied.statusCode).toBe(400);
        await host.putActor({ id: 'alice', companyId: 'example', role: 'employee', permissions: [], active: false });
        expect((await app.inject({ method: 'POST', url: '/v1/invoke', headers: { authorization: 'Bearer ' + alice }, payload: body })).statusCode).toBe(401);
    }
    finally {
        await app.close();
        await host.close();
    }
});
