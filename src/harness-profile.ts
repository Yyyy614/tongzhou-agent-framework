import { nativePresetRows, type CompanyPreset, type PresetRef } from './presets.js';
import { mkdir, readFile, writeFile, realpath, symlink, lstat, readlink, unlink } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { stringify } from 'yaml';
export interface HarnessConnection {
    id: string;
    token: string;
    agentId: string;
    expiresAt: string;
    modelURL: string;
    mcpURL: string;
    model: string;
    persona: string;
    preset?: PresetRef;
}
/** The same native Cordis patch is consumed by official desktop and web profiles. */
export function companyHarnessPatch(lease: HarnessConnection, preset: CompanyPreset) {
    return [
        ...['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis', 'session-title-llm', 'llm-deepseek-account', 'session-log-deepseek', 'plugin-package-inventory-deepseek', 'desktop-product-telemetry', 'product-analytics', 'web-search-deepseek', 'tool-web', 'llm-retry'].map(id => ({ id, disabled: true })),
        { id: 'system-prompt', config: { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '' } },
        { id: 'agent-preset-registry', config: { default: preset.id } },
        { id: 'llm-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: lease.modelURL, thinking: 'disabled', reasoningEffort: 'off', defaultContextWindow: 16000, streamIdleTimeoutMs: 60000 } },
        { insert: [
                ...nativePresetRows([preset], { ref: preset, persona: lease.persona }),
                { id: 'company-client-bridge', name: '@company/framework-connection', config: { mcpURL: lease.mcpURL, modelURL: lease.modelURL, token: lease.token } },
            ] },
    ];
}
export async function prepareHarnessProfile(home: string, profile: 'desktop' | 'web', lease: HarnessConnection, preset: CompanyPreset) {
    const logicalDeployment = resolve(home, 'profiles', profile, 'deployments/framework-connection');
    await mkdir(home, { recursive: true });
    home = await realpath(home);
    const profileDirectory = resolve(home, 'profiles', profile);
    // Native dependency routing requires modules within a profile or linked root.
    const deployed = resolve(profileDirectory, 'deployments/framework-connection');
    const modules = resolve(profileDirectory, 'node_modules/@company');
    await mkdir(deployed, { recursive: true });
    await mkdir(modules, { recursive: true });
    await writeFile(resolve(deployed, 'index.mjs'), await readFile(new URL('../packages/harness-company-bundle/client.mjs', import.meta.url), 'utf8'));
    await writeFile(resolve(deployed, 'package.json'), JSON.stringify({ name: '@company/framework-connection', version: '0.1.0', private: true, type: 'module', exports: { '.': './index.mjs', './cordis.patch.yml': './cordis.patch.yml', './package.json': './package.json' }, dependencies: { '@deepseek-ai/dsh-mcp-client': '0.2.2-rc.2' }, engines: { dsh: '0.2.2-rc.2' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2));
    await writeFile(resolve(deployed, 'cordis.patch.yml'), '# Company-managed connection. Personal overrides stay in the profile patch.\n' + stringify(companyHarnessPatch(lease, preset)));
    const link = resolve(modules, 'framework-connection');
    try {
        if (await realpath(link) !== await realpath(deployed))
            throw new Error('Company connection package is already owned by another path');
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error;
        const existing = await lstat(link).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
        if (existing) {
            const target = existing.isSymbolicLink() ? resolve(await readlink(link)) : '';
            const canonicalTarget = target ? await realpath(target).catch(() => '') : '';
            if (!existing.isSymbolicLink() || (target.toLowerCase() !== logicalDeployment.toLowerCase() && canonicalTarget !== await realpath(deployed))) throw new Error('Company connection link needs administrator repair');
            await unlink(link);
        }
        await symlink(await realpath(deployed), link, process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (await realpath(link) !== await realpath(deployed)) throw new Error('Company connection module could not be mounted');
    const manifestPath = resolve(profileDirectory, 'package.json');
    let manifest: any;
    try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error;
        manifest = { name: 'dsh-profile-' + profile, private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } };
    }
    if (!Array.isArray(manifest.dsh?.profile?.bundles))
        throw new Error('Invalid Harness profile manifest');
    manifest.dependencies ??= {};
    manifest.dependencies['@company/framework-connection'] = 'file:' + relative(profileDirectory, deployed).replaceAll('\\', '/');
    if (!manifest.dsh.profile.bundles.includes('@company/framework-connection'))
        manifest.dsh.profile.bundles.push('@company/framework-connection');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    // Never parse or rewrite employee overrides, including native !!js expressions.
    try {
        await writeFile(resolve(profileDirectory, 'cordis.patch.yml'), '# Personal Harness preferences.\n- id: ui-settings\n  config:\n    enabled: false\n', { flag: 'wx' });
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
            throw error;
    }
    return { profileDirectory, deployed };
}
