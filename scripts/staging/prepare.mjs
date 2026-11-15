import { cp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stage = resolve(root, '.local/staging');
const bundle = resolve(stage, 'bundle-' + randomUUID());
await mkdir(resolve(bundle, 'release/scripts/staging'), { recursive: true });
// Nested writable state needs a mountpoint in the read-only release bind.
await mkdir(resolve(bundle, 'release/.local'), { recursive: true });
await mkdir(resolve(stage, 'private'), { recursive: true });
for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'plugin.schema.json']) await copyFile(resolve(root, file), resolve(bundle, 'release', file));
for (const folder of ['dist', 'web', 'packages/harness-company-bundle', 'packages/work-assistant', 'packages/connection-catalog', 'fixtures/conformance-plugin']) await cp(resolve(root, folder), resolve(bundle, 'release', folder), { recursive: true });
for (const file of ['load-secrets.mjs', 'container-entrypoint.mjs', 'issue-console.mjs', 'check-harness-start.mjs']) await copyFile(resolve(root, 'scripts/staging', file), resolve(bundle, 'release/scripts/staging', file));
for (const file of ['deploy.sh', 'rollback.sh', 'create-tunnel-user.sh', 'nginx-test.conf', 'upgrade-https.sh', 'update-framework.sh']) await copyFile(resolve(root, 'scripts/staging', file), resolve(bundle, file));
await writeFile(resolve(bundle, '.project-scope'), 'company-agent-staging\n');
const secretPath = resolve(stage, 'private/app-secrets.json');
let secrets;
try { secrets = JSON.parse(await readFile(secretPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (!secrets) {
    const databasePassword = randomBytes(32).toString('hex');
    secrets = { DATABASE_URL: 'postgresql://caf_test:' + databasePassword + '@caf-staging-db:5432/caf_staging', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? '', DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com', DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash' };
    await writeFile(secretPath, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' });
    await writeFile(resolve(stage, 'private/postgres.env'), 'POSTGRES_USER=caf_test\nPOSTGRES_DB=caf_staging\nPOSTGRES_PASSWORD=' + databasePassword + '\n', { mode: 0o600, flag: 'wx' });
}
const archive = resolve(stage, 'framework-staging.tgz');
const result = spawnSync('tar.exe', ['-czf', archive, '-C', bundle, '.'], { windowsHide: true, stdio: 'inherit' });
if (result.status !== 0) throw new Error('Staging archive creation failed');
const bytes = await readFile(archive);
await writeFile(resolve(stage, 'artifact.json'), JSON.stringify({ archive, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), scope: 'company-agent-staging', remoteRoot: '/srv/company-agent-staging', publicOrigin: 'http://127.0.0.1:14317', modelCredentialPresent: !!secrets.DEEPSEEK_API_KEY }, null, 2));
console.log(JSON.stringify({ prepared: true, bytes: bytes.length, modelCredentialPresent: !!secrets.DEEPSEEK_API_KEY, privateFilesExcludedFromArchive: true }));
