import { test, expect } from 'vitest';
import { mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
test('write tools require an administrator approval bound to employee, agent, version and exact input', async () => {
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/approval-'));
    const host = await createFramework({ root });
    try {
        const source = resolve(root, 'source');
        await cp(resolve('fixtures/conformance-plugin'), source, { recursive: true });
        const manifest = JSON.parse(await readFile(resolve(source, 'agent-plugin.json'), 'utf8'));
        manifest.provides.tools[0].effect = 'write';
        await writeFile(resolve(source, 'agent-plugin.json'), JSON.stringify(manifest));
        await host.installPlugin(source);
        await host.putActor({ id: 'admin', companyId: 'example', role: 'admin', permissions: [] });
        await host.putActor({ id: 'alice', companyId: 'example', role: 'employee', permissions: ['tool.invoke:@example/conformance:text.normalize'] });
        await host.putAgent({ id: 'worker', companyId: 'example', ownerId: 'alice', pluginId: manifest.id, pluginVersion: '0.1.0', allowedTools: ['@example/conformance:text.normalize'] });
        const request = { principalId: 'alice', agentId: 'worker', toolRef: '@example/conformance:text.normalize', input: { text: ' approved ' }, idempotencyKey: 'one' };
        await expect(host.invoke(request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
        await host.approveTool({ principalId: 'admin', targetPrincipalId: 'alice', agentId: 'worker', toolRef: request.toolRef, input: request.input, reason: 'Confirmed test write' });
        await expect(host.invoke({ ...request, input: { text: 'changed' } })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
        const first = await host.invoke(request);
        expect(first.output).toEqual({ text: 'approved' });
        expect(await host.invoke(request)).toEqual(first);
        await expect(host.invoke({ ...request, idempotencyKey: 'second-action' })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    }
    finally {
        await host.close();
    }
});
