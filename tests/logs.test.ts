import { test, expect } from 'vitest';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
test('audit is persistent, scoped, redacted, and deduplicated calls return their receipt', async () => {
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/logs-'));
    const host = await createFramework({ root });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        for (const id of ['alice', 'bob', 'manager'])
            await host.putActor({ id, companyId: 'example', role: 'employee', permissions: id === 'manager' ? ['agent.read:worker'] : ['tool.invoke:@example/conformance:text.normalize'] });
        await host.putAgent({ id: 'worker', ownerId: 'alice', companyId: 'example', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: ['@example/conformance:text.normalize'] });
        const request = { principalId: 'alice', agentId: 'worker', toolRef: '@example/conformance:text.normalize', input: { text: ' a  b ' }, idempotencyKey: 'once' };
        const first = await host.invoke(request);
        expect(await host.invoke(request)).toEqual(first);
        await expect(host.invoke({ ...request, input: { text: 'other' } })).rejects.toMatchObject({ code: 'CONFLICT' });
        await host.db.audit('test.redaction', { agentId: 'worker', apiKey: 'private', nested: { token: 'private' }, message: 'sk-thisisatestsecretvalue' });
        const logs = await host.listLogs({ principalId: 'manager', agentId: 'worker' });
        expect(logs.filter(l => l.type === 'tool.succeeded')).toHaveLength(1);
        expect(JSON.stringify(logs)).not.toContain('private');
        expect(JSON.stringify(logs)).not.toContain('sk-thisisatestsecretvalue');
        await expect(host.listLogs({ principalId: 'bob', agentId: 'worker' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        await expect(host.invoke({ ...request, principalId: 'manager', idempotencyKey: 'manager' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    finally {
        await host.close();
    }
});
