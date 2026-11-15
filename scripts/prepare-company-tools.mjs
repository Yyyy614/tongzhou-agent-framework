import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const env = { ...process.env };
for (const key of Object.keys(env)) if (/proxy|^node_options$|^global_agent/iu.test(key)) delete env[key];
env.electron_config_cache = resolve(root, '.tools/electron-download-cache');
if (process.argv.includes('--mirror')) env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
await mkdir(resolve(root, '.tools/company-build-tools'), { recursive: true });
const npm = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const args = process.argv.includes('--electron-runtime')
    ? [resolve(root,'.tools/company-build-tools/node_modules/electron/install.js')]
    : [npm, 'install', '--prefix', '.tools/company-build-tools', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--registry=https://registry.npmjs.org', '--proxy=false', '--https-proxy=false', 'esbuild@0.25.12', '@electron/asar@4.0.1', 'electron@44.7.0'];
const result = spawnSync(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: 'inherit', timeout: 300000 });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
