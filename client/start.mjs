import { readFile, writeFile, mkdir, unlink, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createEmployeeClient, companyOrigin } from './employee-app.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(root, 'company.json'), 'utf8'));
const serverURL = companyOrigin(config.serverURL);
const index = process.argv.indexOf('--data-dir');
const requestedDir = index >= 0 ? resolve(process.argv[index + 1]) : resolve(process.env.LOCALAPPDATA ?? homedir(), 'CompanyAgentFramework', createHash('sha256').update(serverURL).digest('hex').slice(0, 20));
await mkdir(requestedDir, { recursive: true });
const dataDir = await realpath(requestedDir);
const controlPath = resolve(dataDir, 'local-session.json');
async function handoff(info) {
    const position = process.argv.indexOf('--handoff-file');
    if (position < 0) return;
    if (!process.argv[position + 1]) throw Error('Desktop handoff path is required');
    const path = resolve(process.argv[position + 1]);
    await writeFile(path, JSON.stringify(info), { mode: 0o600, flag: 'wx' });
}
function openWindow(url) {
    if (process.argv.includes('--no-open')) return;
    const helper = spawn('explorer.exe', [url], { windowsHide: true, stdio: 'ignore' });
    helper.on('error', () => console.error('无法自动打开接入窗口，请重新启动客户端。'));
}
let existing;
try {
    const saved = JSON.parse(await readFile(controlPath, 'utf8'));
    const url = new URL(saved.origin);
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1') {
        const check = await fetch(url.origin + '/api/ping', { redirect: 'error', headers: { 'x-client-session': saved.session }, signal: AbortSignal.timeout(2000) });
        if (check.ok) {
            const ping = await check.json();
            if (ping.ready && (ping.clientProtocol !== 3 || ping.clientVersion !== config.version)) throw Object.assign(Error('其他版本员工服务仍在运行，请先退出旧客户端再打开新版。'), { code: 'CLIENT_UPGRADE_REQUIRED' });
            if (ping.ready) existing = saved;
        }
    }
} catch (error) { if (error.code === 'CLIENT_UPGRADE_REQUIRED') throw error; }
if (existing) {
    await handoff(existing);
    let opened = false;
    if (process.argv.includes('--open-harness')) {
        try { const response = await fetch(existing.origin + '/api/open-default', { method: 'POST', headers: { origin: existing.origin, 'x-client-session': existing.session }, signal: AbortSignal.timeout(30000) }); opened = response.ok && (await response.json()).started === true; } catch { }
    }
    if (!opened) openWindow(existing.origin + '/#session=' + existing.session);
    console.log('已打开这台电脑正在运行的员工接入窗口。');
} else {
    const app = await createEmployeeClient({ serverURL, dataDir, clientVersion: config.version });
    await mkdir(dataDir, { recursive: true });
    await writeFile(controlPath, JSON.stringify({ origin: app.origin, session: app.session }), { mode: 0o600 });
    await handoff({ origin: app.origin, session: app.session });
    let opened = false;
    if (process.argv.includes('--open-harness')) { try { opened = (await app.openDefault()).started === true; } catch { } }
    if (!opened) openWindow(app.url);
    console.log('员工接入窗口已启动。请保持此窗口运行，工作在 Harness 内完成。');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => unlink(controlPath).catch(() => {})); });
}
