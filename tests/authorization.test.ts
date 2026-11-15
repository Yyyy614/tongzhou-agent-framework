import { expect, test } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
test('tool execution intersects employee identity, agent ownership, allowlist and input schema', async () => {
    const root = await mkdtemp(resolve('.test-data/auth-'));
    const host = await createFramework({ root });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        const tool = '@example/conformance:text.normalize';
        await host.putActor({ id: 'alice', companyId: 'example', role: 'employee', permissions: ['tool.invoke:' + tool] });
        await host.putActor({ id: 'bob', companyId: 'example', role: 'employee', permissions: ['tool.invoke:' + tool] });
        await host.putAgent({ id: 'worker-a', companyId: 'example', ownerId: 'alice', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [tool] });
        const request = { principalId: 'alice', agentId: 'worker-a', toolRef: tool, input: { text: '  first\n second  ' }, idempotencyKey: 'normal-1' };
        expect(await host.invoke(request)).toMatchObject({ outcome: 'succeeded', output: { text: 'first second' } });
        await expect(host.invoke({ ...request, principalId: 'bob', idempotencyKey: 'denied-1' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        await expect(host.invoke({ ...request, input: { text: 'x', principalId: 'alice' }, idempotencyKey: 'invalid-1' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await host.putAgent({ id: 'worker-b', companyId: 'example', ownerId: 'bob', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        await expect(host.invoke({ ...request, principalId: 'bob', agentId: 'worker-b', idempotencyKey: 'denied-2' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    finally {
        await host.close();
    }
});
