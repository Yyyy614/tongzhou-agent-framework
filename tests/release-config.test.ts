import { test, expect } from 'vitest';
import { mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
test('release validates and initializes a candidate with the actual bound configuration', async () => {
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/release-config-'));
    const host = await createFramework({ root });
    try {
        const first = resolve(root, 'first');
        await cp(resolve('fixtures/conformance-plugin'), first, { recursive: true });
        const manifest = JSON.parse(await readFile(resolve(first, 'agent-plugin.json'), 'utf8'));
        await writeFile(resolve(first, manifest.configSchema), JSON.stringify({ type: 'object', required: ['prefix'], properties: { prefix: { type: 'string' } }, additionalProperties: false }));
        await host.installPlugin(first);
        await host.putActor({ id: 'admin', companyId: 'example', role: 'admin', permissions: [] });
        await host.putAgent({ id: 'worker', ownerId: 'admin', companyId: 'example', pluginId: manifest.id, pluginVersion: '0.1.0', config: { prefix: 'bound' }, allowedTools: ['@example/conformance:text.normalize'] });
        const second = resolve(root, 'second');
        await cp(first, second, { recursive: true });
        manifest.version = '0.2.0';
        await writeFile(resolve(second, 'agent-plugin.json'), JSON.stringify(manifest));
        await writeFile(resolve(second, 'dist/plugin.mjs'), `export function apply(ctx){if(ctx.config.prefix!=='bound')throw new Error('Missing bound config');ctx.tools.register('text.normalize',async input=>({text:ctx.config.prefix+input.text}));}`);
        await host.installPlugin(second);
        await expect(host.releaseAgent({ principalId: 'admin', agentId: 'worker', pluginVersion: '0.2.0', reason: 'Configured candidate' })).resolves.toMatchObject({ pluginVersion: '0.2.0' });
        const third = resolve(root, 'third');
        await cp(second, third, { recursive: true });
        manifest.version = '0.3.0';
        await writeFile(resolve(third, 'agent-plugin.json'), JSON.stringify(manifest));
        await writeFile(resolve(third, manifest.configSchema), JSON.stringify({ type: 'object', required: ['missing'], properties: { missing: { type: 'string' } } }));
        await host.installPlugin(third);
        await expect(host.releaseAgent({ principalId: 'admin', agentId: 'worker', pluginVersion: '0.3.0', reason: 'Incompatible config' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    finally {
        await host.close();
    }
});
