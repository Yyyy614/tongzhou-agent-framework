import { test, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, realpath, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareHarnessProfile } from '../src/harness-profile.js';
import { PresetCatalog } from '../src/presets.js';

test.skipIf(process.platform !== 'win32')('an AppData company profile resolves its module junction to the real deployment', async () => {
    const parent = resolve(process.env.LOCALAPPDATA!, 'CompanyAgent', 'profile-contract-tests');
    await mkdir(parent, { recursive: true });
    const home = await mkdtemp(resolve(parent, 'native-'));
    const catalog = new PresetCatalog(); await catalog.open();
    const preset = catalog.get({ id: 'company-worker', version: '0.1.0' });
    const lease = { id: 'fixture', token: 'fixture-only', agentId: 'worker', expiresAt: '2099-01-01', model: 'fixture', modelURL: 'http://127.0.0.1/model', mcpURL: 'http://127.0.0.1/mcp', persona: 'fixture' };
    const deployment = resolve(home, 'profiles/desktop/deployments/framework-connection');
    const modules = resolve(home, 'profiles/desktop/node_modules/@company');
    await mkdir(deployment, { recursive: true }); await mkdir(modules, { recursive: true });
    // Old releases wrote a logical AppData junction that Windows cannot follow after MSIX redirection.
    await symlink(deployment, resolve(modules, 'framework-connection'), 'junction');
    const prepared = await prepareHarnessProfile(await realpath(home), 'desktop', lease, preset);
    expect(await realpath(resolve(prepared.profileDirectory, 'node_modules/@company/framework-connection'))).toBe(await realpath(prepared.deployed));
    expect(JSON.parse(await readFile(resolve(prepared.profileDirectory, 'node_modules/@company/framework-connection/package.json'), 'utf8')).name).toBe('@company/framework-connection');
});
test('renewing a native company connection updates its own bundle and preserves personal Harness configuration', async () => {
    await mkdir('.test-data', { recursive: true }); const home = await mkdtemp(resolve('.test-data/native-profile-'));
    const catalog = new PresetCatalog(); await catalog.open(); const preset = catalog.get({ id: 'company-worker', version: '0.1.0' });
    const lease = { id: 'one', token: 'fixture-lease-one', agentId: 'worker', expiresAt: '2099-01-01', model: 'deepseek-flash', modelURL: 'http://127.0.0.1/model/one', mcpURL: 'http://127.0.0.1/mcp/one', persona: 'Complete work.', preset };
    await prepareHarnessProfile(home, 'desktop', lease, preset);
    const personalPath = resolve(home, 'profiles/desktop/cordis.patch.yml');
    const personal = '- id: ui-settings\n  config:\n    enabled: false\n- id: custom-row\n  config:\n    value: !!js process.env.MY_PERSONAL_VALUE\n';
    await writeFile(personalPath, personal);
    await prepareHarnessProfile(home, 'desktop', { ...lease, token: 'fixture-lease-two', modelURL: 'http://127.0.0.1/model/two' }, preset);
    expect(await readFile(personalPath, 'utf8')).toBe(personal);
    const manifest = JSON.parse(await readFile(resolve(home, 'profiles/desktop/package.json'), 'utf8'));
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@company/framework-connection']);
    const mounted = resolve(home, 'profiles/desktop/node_modules/@company/framework-connection');
    expect(JSON.parse(await readFile(resolve(mounted, 'package.json'), 'utf8')).dsh.bundle.patch).toBe('./cordis.patch.yml');
    const deployed = await readFile(resolve(mounted, 'cordis.patch.yml'), 'utf8');
    expect(deployed).toContain('fixture-lease-two'); expect(deployed).not.toContain('fixture-lease-one');
});
