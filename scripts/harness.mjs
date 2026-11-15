import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareHarnessProfile } from '../dist/harness-profile.js';
import { companyFetch } from '../client/company-fetch.mjs';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = new Map();
for (let i = 2; i < process.argv.length; i++) { const key = process.argv[i]; options.set(key, process.argv[i+1]?.startsWith('--') || !process.argv[i+1] ? true : process.argv[++i]); }
const actor = options.get('--actor') ?? 'alice';
const agentId = options.get('--agent') ?? 'reference-bot';
const origin = process.env.COMPANY_AGENT_URL ?? 'http://127.0.0.1:4317';
const token = options.get('--token-file') ? (await readFile(options.get('--token-file'), 'utf8')).trim() : JSON.parse(await readFile(resolve(project,'.local/access.json'), 'utf8'))[actor];
async function request(path, method = 'GET', body) {
    const response = await companyFetch(origin, path, { method, body, token, timeoutMs: 10000 });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.code ?? 'COMPANY_CONNECTION_FAILED');
    return result;
}
const web = options.has('--web');
const executable = options.get('--desktop-exe') ?? resolve(project, '.tools/harness-desktop/DeepSeek Harness.exe');
if (!web && !options.has('--desktop-exe')) {
    const baseline = JSON.parse(await readFile(resolve(project, 'harness-desktop.lock.json'), 'utf8'));
    async function hashFile(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
    try {
        if (await hashFile(executable) !== baseline.executableSHA256 || await hashFile(resolve(dirname(executable), 'resources/app.asar')) !== baseline.asarSHA256) throw new Error('Desktop does not match the framework baseline');
    } catch { throw new Error('Prepare the pinned Desktop with pwsh -NoProfile -File scripts/setup-harness-desktop.ps1'); }
}
const connection = await request('/v1/harness/clients', 'POST', { agentId });
const catalog = await request('/v1/presets');
const preset = catalog.find(p => p.id === (connection.preset?.id ?? 'company-worker') && p.version === (connection.preset?.version ?? '0.1.0'));
if (!preset) throw new Error('Pinned company preset is not installed');
const home = resolve(project, '.local/harness-clients', createHash('sha256').update('native-bundle-v2:' + origin + ':' + connection.companyId + ':' + connection.principalId + ':' + agentId + ':' + (web ? 'web' : 'desktop')).digest('hex').slice(0,20));
const profile = web ? 'web' : 'desktop';
await prepareHarnessProfile(home, profile, connection, preset);
const env = {};
for (const key of ['PATH','Path','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','USERNAME']) if (process.env[key]) env[key] = process.env[key];
Object.assign(env, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_DESKTOP_OPEN_DEVTOOLS: '0', DEEPSEEK_API_KEY: connection.token, DEEPSEEK_BASE_URL: connection.modelURL });
await writeFile(resolve(home, 'connection.json'), JSON.stringify({ home, executable, env, id: connection.id, agentId, expiresAt: connection.expiresAt }, null, 2));
if (options.has('--prepare')) { console.log(JSON.stringify({ prepared: true, home, executable, agentId, expiresAt: connection.expiresAt })); }
else {
const require = createRequire(import.meta.url);
const cli = createRequire(require.resolve('@deepseek-ai/dsh-sdk-client')).resolve('@deepseek-ai/dsh/lib/bin.js');
const child = spawn(web ? process.execPath : executable, web ? [cli, '--profile', 'web', '--no-open', '--port', String(options.get('--port') ?? 3089)] : ['--user-data-dir=' + resolve(home, 'electron-user-data')], { cwd: home, env, stdio: ['ignore','pipe','pipe'], windowsHide: web });
const log = resolve(home, 'native.log');
await writeFile(log, '');
let opened = false, pending = '';
child.stdout.on('data', async chunk => {
    await appendFile(log, chunk); pending = (pending + chunk.toString('utf8')).slice(-10000);
    const match = pending.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/u);
    if (web && match && !opened) {
        opened = true;
        console.log(JSON.stringify({ ready: true, mode: 'harness-web', origin: new URL(match[1]).origin, home, agentId }));
        if (!options.has('--no-open')) {
            const openEnv = {};
            for (const key of ['PATH','Path','SystemRoot','WINDIR','COMSPEC','TEMP','TMP']) if (process.env[key]) openEnv[key] = process.env[key];
            openEnv.COMPANY_HARNESS_OPEN_URL = match[1];
            spawn('pwsh.exe', ['-NoProfile','-Command','Start-Process -FilePath $env:COMPANY_HARNESS_OPEN_URL -WindowStyle Hidden'], { env: openEnv, windowsHide: true, stdio: 'ignore' });
        }
    }
});
child.stderr.on('data', chunk => { void appendFile(log, chunk); });
child.on('error', async () => { console.error('Harness could not start. Check the configured desktop executable.'); await request('/v1/harness/clients/' + connection.id, 'DELETE').catch(()=>{}); process.exitCode = 1; });
child.on('exit', async code => { await request('/v1/harness/clients/' + connection.id, 'DELETE').catch(()=>{}); process.exitCode = code ?? 1; });
if (!web) console.log(JSON.stringify({ started: true, mode: 'harness-desktop', home, agentId }));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { child.kill(); });
}
