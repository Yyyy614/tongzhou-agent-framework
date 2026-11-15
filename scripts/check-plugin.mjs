// Install and initialize a plugin in an isolated directory. No company DB or credentials.
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { PluginRegistry } from '../dist/plugins/registry.js';
import { PluginWorker } from '../dist/plugins/worker.js';
const directory = process.argv[2];
if (!directory) throw Error('Usage: node scripts/check-plugin.mjs <plugin-directory>');
await mkdir('.local/plugin-checks', { recursive: true });
const root = await mkdtemp(resolve('.local/plugin-checks/package-'));
const registry = new PluginRegistry(root); await registry.open();
const plugin = await registry.install(resolve(directory));
let peer;
try {
    if (plugin.manifest.entry.kind === 'module') {
        peer = new PluginWorker(root, async () => { throw Object.assign(Error('Package checks do not grant host services'), { code: 'PERMISSION_DENIED' }); });
        const initialized = await peer.call('plugin.initialize', { protocol: '1.0', entry: await registry.packagePath(plugin.directory, plugin.manifest.entry.path), config: {} });
        assert.equal(initialized.protocol, '1.0');
        assert.deepEqual([...initialized.tools].sort(), plugin.manifest.provides.tools.map(t => t.id).sort());
        assert.equal((await peer.call('plugin.health', {})).status, 'ready');
        assert.equal((await peer.call('capability.describe', {})).protocol, '1.0');
    }
    console.log(JSON.stringify({ valid: true, id: plugin.id, version: plugin.version, schemaVersion: plugin.manifest.schemaVersion, digest: plugin.digest, tools: plugin.manifest.provides.tools.length, remoteInitializationChecked: false, hostServicesGranted: false }));
} finally { await peer?.close(); }
