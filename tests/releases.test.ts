import { test, expect } from 'vitest';
import { mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
test('an administrator publishes a validated version to one agent and can roll it back', async () => {
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/releases-'));
    const host = await createFramework({ root });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        const source = resolve(root, 'v2');
        await cp(resolve('fixtures/conformance-plugin'), source, { recursive: true });
        const manifest = JSON.parse(await readFile(resolve(source, 'agent-plugin.json'), 'utf8'));
        manifest.version = '0.2.0';
        await writeFile(resolve(source, 'agent-plugin.json'), JSON.stringify(manifest));
        await writeFile(resolve(source, 'dist/plugin.mjs'), `export function apply(ctx){ctx.tools.register('text.normalize',async input=>({text:input.text.trim().toUpperCase()}));}`);
        await host.installPlugin(source);
        await host.putActor({ id: 'admin', companyId: 'example', role: 'admin', permissions: [] });
        await host.putActor({ id: 'alice', companyId: 'example', role: 'employee', permissions: ['tool.invoke:@example/conformance:text.normalize'] });
        for (const id of ['a', 'b'])
            await host.putAgent({ id, companyId: 'example', ownerId: 'alice', pluginId: manifest.id, pluginVersion: '0.1.0', allowedTools: ['@example/conformance:text.normalize'] });
        await expect(host.releaseAgent({ principalId: 'alice', agentId: 'a', pluginVersion: '0.2.0', reason: 'test' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        await host.releaseAgent({ principalId: 'admin', agentId: 'a', pluginVersion: '0.2.0', reason: 'Fix normalized output' });
        const invoke = (agentId: string, idempotencyKey: string) => host.invoke({ principalId: 'alice', agentId, toolRef: '@example/conformance:text.normalize', input: { text: ' hello ' }, idempotencyKey });
        expect((await invoke('a', 'v2')).output).toEqual({ text: 'HELLO' });
        expect((await invoke('b', 'v1')).output).toEqual({ text: 'hello' });
        await host.releaseAgent({ principalId: 'admin', agentId: 'a', pluginVersion: '0.1.0', reason: 'Rollback verification' });
        expect((await invoke('a', 'rollback')).output).toEqual({ text: 'hello' });
        const logs = await host.listLogs({ principalId: 'admin', agentId: 'a' });
        expect(logs.filter(l => l.type === 'release.applied')).toHaveLength(2);
    }
    finally {
        await host.close();
    }
});
