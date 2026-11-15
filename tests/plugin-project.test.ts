import { test, expect } from 'vitest';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFramework } from '../src/index.js';

test('a developer creates and mounts an external plugin without importing or changing the host implementation', async () => {
    await mkdir('.test-data', { recursive: true });
    const directory = await mkdtemp(resolve('.test-data/plugin-project-'));
    const source = resolve(directory, 'external-capability');
    const generated = spawnSync(process.execPath, ['scripts/create-plugin.mjs', source, '--id', '@independent/review'], { encoding: 'utf8', windowsHide: true });
    expect(generated.status, generated.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(resolve(source, 'agent-plugin.json'), 'utf8'));
    expect(manifest.id).toBe('@independent/review');
    expect(await readFile(resolve(source, 'plugin.mjs'), 'utf8')).not.toMatch(/(?:src\/|\.\.\/.*framework|node_modules)/u);
    const host = await createFramework({ root: resolve(directory, 'host') });
    try {
        await host.installPlugin(source);
        await host.putActor({ id: 'employee', companyId: 'other-company', role: 'employee', permissions: ['tool.invoke:@independent/review:record.inspect'] });
        await host.putAgent({ id: 'job', ownerId: 'employee', companyId: 'other-company', pluginId: manifest.id, pluginVersion: manifest.version, allowedTools: ['@independent/review:record.inspect'] });
        const invoke = (key: string, input: unknown) => host.invoke({ principalId: 'employee', agentId: 'job', toolRef: '@independent/review:record.inspect', input, idempotencyKey: key });
        expect((await invoke('one', { text: '  Independent capability  ' })).output).toEqual({ text: 'Independent capability' });
        await expect(invoke('invalid', { text: 12 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        // Refuse overwrite of an existing developer package, including its custom code.
        const repeated = spawnSync(process.execPath, ['scripts/create-plugin.mjs', source, '--id', manifest.id], { encoding: 'utf8', windowsHide: true });
        expect(repeated.status).not.toBe(0);
        expect((await invoke('still-works', { text: 'preserved' })).output).toEqual({ text: 'preserved' });
    } finally { await host.close(); }
});
