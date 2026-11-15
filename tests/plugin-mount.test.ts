import { afterEach, expect, test } from 'vitest';
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
const hosts: any[] = [];
afterEach(async () => {
    for (const host of hosts.splice(0))
        await host.close();
});
test('an installed plugin exposes its declared tool and incompatible protocol is rejected', async () => {
    const root = await mkdtemp(resolve('.test-data/mount-'));
    const host = await createFramework({ root });
    hosts.push(host);
    const installed = await host.installPlugin(resolve('fixtures/conformance-plugin'));
    expect(installed).toMatchObject({ id: '@example/conformance', version: '0.1.0' });
    expect(await host.listTools()).toEqual([expect.objectContaining({ id: '@example/conformance:text.normalize', effect: 'read' })]);
    const incompatible = resolve(root, 'incompatible');
    await cp('fixtures/conformance-plugin', incompatible, { recursive: true });
    const file = resolve(incompatible, 'agent-plugin.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.engine.protocol = '9.0';
    await writeFile(file, JSON.stringify(manifest));
    await expect(host.installPlugin(incompatible)).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });
});
