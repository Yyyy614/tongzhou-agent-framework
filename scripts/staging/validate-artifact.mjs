import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const stage = resolve(process.env.STAGING_OUTPUT_DIR ?? '.local/staging');
const artifact = JSON.parse(await readFile(resolve(stage, 'artifact.json'), 'utf8'));
const listed = spawnSync('tar.exe', ['-tzf', artifact.archive], { encoding: 'utf8', windowsHide: true });
if (listed.status !== 0) throw new Error('Staging archive cannot be read');
const entries = listed.stdout.split(/\r?\n/u).filter(Boolean);
for (const required of ['release/package.json', 'release/plugin.schema.json', 'release/dist/cli.js', 'release/dist/plugins/worker.mjs', 'release/packages/harness-company-bundle/presets.json', 'release/fixtures/conformance-plugin/agent-plugin.json', 'release/scripts/staging/load-secrets.mjs', 'deploy.sh', 'rollback.sh', '.project-scope']) {
    if (!entries.includes('./' + required)) throw new Error('Staging runtime file is missing: ' + required);
}
if (!entries.includes('./release/.local/')) throw new Error('Writable state mountpoint is missing');
// Only the empty mountpoint is allowed; every file beneath it is still forbidden.
if (entries.some(p => p !== './release/.local/' && (/(?:^|\/)(?:\.env|\.local|\.git|node_modules|private)(?:\/|$)/u.test(p) || /\.(?:pem|key)$/u.test(p)))) throw new Error('Private/developer material is present in the staging archive');
console.log(JSON.stringify({ validated: true, files: entries.length, requiredRuntimeFilesPresent: true, privateMaterialExcluded: true }));
