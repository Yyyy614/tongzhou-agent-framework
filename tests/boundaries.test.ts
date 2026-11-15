import { test, expect } from 'vitest';
import { mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
test('cross-company administrators, changed immutable artifacts, escaping paths and invalid outputs are rejected', async () => {
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/boundaries-'));
    const host = await createFramework({ root });
    try {
        const source = resolve(root, 'source');
        await cp(resolve('fixtures/conformance-plugin'), source, { recursive: true });
        await host.installPlugin(source);
        await host.putActor({ id: 'alice', companyId: 'one', role: 'employee', permissions: ['tool.invoke:@example/conformance:text.normalize'] });
        await host.putActor({ id: 'foreign', companyId: 'two', role: 'admin', permissions: [] });
        await host.putAgent({ id: 'worker', ownerId: 'alice', companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: ['@example/conformance:text.normalize'] });
        await expect(host.invoke({ principalId: 'foreign', agentId: 'worker', toolRef: '@example/conformance:text.normalize', input: { text: 'x' }, idempotencyKey: 'foreign' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        await writeFile(resolve(source, 'dist/plugin.mjs'), 'changed');
        await expect(host.installPlugin(source)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
        const manifest = JSON.parse(await readFile(resolve(source, 'agent-plugin.json'), 'utf8'));
        manifest.version = '0.2.0';
        manifest.entry.path = './../outside.mjs';
        await writeFile(resolve(source, 'agent-plugin.json'), JSON.stringify(manifest));
        await expect(host.installPlugin(source)).rejects.toMatchObject({ code: 'INVALID_PACKAGE' });
        manifest.entry.path = './dist/plugin.mjs';
        await writeFile(resolve(source, 'agent-plugin.json'), JSON.stringify(manifest));
        await writeFile(resolve(source, 'dist/plugin.mjs'), `export function apply(ctx){ctx.tools.register('text.normalize',async()=>({wrong:true}));}`);
        await host.installPlugin(source);
        await host.putAgent({ id: 'bad', ownerId: 'alice', companyId: 'one', pluginId: manifest.id, pluginVersion: '0.2.0', allowedTools: ['@example/conformance:text.normalize'] });
        await expect(host.invoke({ principalId: 'alice', agentId: 'bad', toolRef: '@example/conformance:text.normalize', input: { text: 'x' }, idempotencyKey: 'bad-output' })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    }
    finally {
        await host.close();
    }
});
