import { test, expect } from 'vitest';
import { mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
test('one agent composes independently versioned plugin packages without kernel changes', async () => {
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/composition-'));
    const host = await createFramework({ root });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        const source = resolve(root, 'other');
        await cp(resolve('fixtures/conformance-plugin'), source, { recursive: true });
        const manifest = JSON.parse(await readFile(resolve(source, 'agent-plugin.json'), 'utf8'));
        manifest.id = '@example/other';
        await writeFile(resolve(source, 'agent-plugin.json'), JSON.stringify(manifest));
        await writeFile(resolve(source, 'dist/plugin.mjs'), `export function apply(ctx){ctx.tools.register('text.normalize',async input=>({text:input.text.toUpperCase()}));}`);
        await host.installPlugin(source);
        const refs = ['@example/conformance:text.normalize', '@example/other:text.normalize'];
        await host.putActor({ id: 'alice', companyId: 'example', role: 'employee', permissions: refs.map(t => 'tool.invoke:' + t) });
        await host.putAgent({ id: 'worker', ownerId: 'alice', companyId: 'example', pluginId: '@example/conformance', pluginVersion: '0.1.0', plugins: [{ pluginId: '@example/other', pluginVersion: '0.1.0' }], allowedTools: refs });
        const invoke = (toolRef: string) => host.invoke({ principalId: 'alice', agentId: 'worker', toolRef, input: { text: ' a  b ' }, idempotencyKey: 'once' });
        expect((await invoke(refs[0]!)).output).toEqual({ text: 'a b' });
        expect((await invoke(refs[1]!)).output).toEqual({ text: ' A  B ' });
    }
    finally {
        await host.close();
    }
});
