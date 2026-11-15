import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir, unlink, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { windowsProtection } from './credential-store.mjs';
import { companyFetch } from './company-fetch.mjs';

export function companyOrigin(value) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('公司服务必须使用 HTTPS；HTTP 仅用于本机验证。');
    return url.origin;
}
const error = (message, status = 400) => Object.assign(new Error(message), { status });
export async function createEmployeeClient(options) {
    const serverURL = companyOrigin(options.serverURL);
    await mkdir(resolve(options.dataDir), { recursive: true });
    const dataDir = await realpath(resolve(options.dataDir));
    const protection = options.protection ?? windowsProtection;
    const identityPath = resolve(dataDir, 'identity.json');
    let identity, accessToken, native, opening = false, closing;
    try {
        identity = JSON.parse(await readFile(identityPath, 'utf8'));
        if (identity.serverURL !== serverURL) throw error('这个设备目录属于另一家公司服务。');
        accessToken = await protection.decrypt(identity.encryptedToken);
    } catch (e) { if (e.code !== 'ENOENT') throw error('无法读取这台电脑的登录信息。请使用原 Windows 用户，或新的设备目录重新激活。'); }
    async function remote(path, method = 'GET', body, credential = accessToken) {
        const response = await companyFetch(serverURL, path, { method, body, token: credential });
        const result = await response.json();
            if (!response.ok) throw Object.assign(error(({ UNAUTHENTICATED: '账号、密码或接入码不正确，或登录已失效。', PERMISSION_DENIED: '当前员工没有此操作权限。', CONFLICT: '岗位或任务状态已变化，请关闭 Harness 后重新打开。', BUDGET_EXCEEDED: '尝试过于频繁或设备额度已满，请稍后重试或联系管理员。', INVALID_INPUT: '输入或岗位配置不完整，请检查后重试。' })[result.error?.code] ?? '公司服务未确认操作，请刷新状态后核对。', response.status), { code: result.error?.code });
        return result;
    }
    async function state() {
        if (!accessToken) return { authenticated: false, serverURL, clientVersion: options.clientVersion };
        try { return { authenticated: true, serverURL, clientVersion: options.clientVersion, ...await remote('/v1/employee/bootstrap'), harnessOpen: !!native, opening }; }
        catch (e) { if (e.status === 401) return { authenticated: false, serverURL, expired: true, harnessOpen: !!native }; throw e; }
    }
    async function stopNative() {
        const current = native;
        if (!current) return;
        native = undefined;
        current.child.kill();
        await current.release();
    }
    async function openNative(agentId) {
        if (opening) throw error('正在打开 Harness，请稍候。', 409);
        if (native) { if (native.agentId === agentId) return { started: true, alreadyOpen: true, processId: native.child.pid }; throw error('请先关闭当前岗位的 Harness。', 409); }
        opening = true;
        let lease;
        try {
            const boot = await state();
            if (!boot.authenticated || !boot.agents.some(a => a.id === agentId)) throw error('请选择本人已分配的岗位。', 403);
            const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
            const executable = options.desktopPath ?? resolve(root, 'desktop/DeepSeek Harness.exe');
            const baseline = JSON.parse(await readFile(resolve(root, 'harness-desktop.lock.json'), 'utf8'));
            async function digest(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
            if (await digest(executable) !== baseline.executableSHA256 || await digest(resolve(dirname(executable), 'resources/app.asar')) !== baseline.asarSHA256) throw error('Harness 版本与公司客户端不一致，请重新获取客户端。');
            lease = await remote('/v1/harness/clients', 'POST', { agentId });
            const catalog = await remote('/v1/presets');
            const preset = catalog.find(p => p.id === lease.preset?.id && p.version === lease.preset?.version);
            if (!preset) throw error('管理员尚未为这个岗位分配有效预设。');
            const { prepareHarnessProfile } = await import('../dist/harness-profile.js');
            const home = resolve(dataDir, 'harness', createHash('sha256').update(boot.employee.companyId + ':' + boot.employee.id + ':' + agentId).digest('hex').slice(0, 20));
            await prepareHarnessProfile(home, 'desktop', lease, preset);
            const env = {};
            for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'USERNAME']) if (process.env[key]) env[key] = process.env[key];
            Object.assign(env, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NODE_USE_SYSTEM_CA: '1', DEEPSEEK_API_KEY: lease.token, DEEPSEEK_BASE_URL: lease.modelURL });
            const child = spawn(executable, ['--user-data-dir=' + resolve(home, 'electron-user-data')], { cwd: home, env, windowsHide: false, stdio: 'ignore' });
            await once(child, 'spawn');
            const leaseId = lease.id, credential = accessToken;
            const release = () => remote('/v1/harness/clients/' + leaseId, 'DELETE', undefined, credential).catch(() => {});
            native = { child, release, agentId };
            child.on('exit', () => { if (native?.child === child) native = undefined; void release(); });
            return { started: true, processId: child.pid };
        } catch (e) { if (lease) await remote('/v1/harness/clients/' + lease.id, 'DELETE').catch(() => {}); throw e; }
        finally { opening = false; }
    }
    async function openDefault() {
        const boot = await state();
        if (!boot.authenticated || boot.agents.length !== 1) return { started: false };
        return openNative(boot.agents[0].id);
    }
    const session = randomBytes(32).toString('base64url');
    let origin;
    const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/result-view.mjs': ['result-view.mjs', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
    const server = createServer(async (request, response) => {
        const send = (status, body, type = 'application/json; charset=utf-8') => { response.writeHead(status, { 'content-type': type }); response.end(type.startsWith('application/json') ? JSON.stringify(body) : body); };
        response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        try {
            const path = new URL(request.url, origin).pathname;
            if (request.method === 'GET' && files[path]) { const [file, type] = files[path]; return send(200, await readFile(new URL('./web/' + file, import.meta.url), 'utf8'), type); }
            if (request.headers['x-client-session'] !== session) throw error('请从本机客户端启动入口打开。', 401);
            if (closing) throw error('客户端正在关闭。', 503);
            if (request.method !== 'GET' && request.headers.origin !== origin) throw error('请在本机接入窗口操作。', 403);
            if (request.method === 'GET' && path === '/api/ping') return send(200, { ready: true, clientProtocol: 3, clientVersion: options.clientVersion });
            if (request.method === 'GET' && path === '/api/state') return send(200, await state());
            if (request.method === 'GET' && path === '/api/work') return send(200, await remote('/v1/work'));
            if (request.method === 'GET' && path === '/api/inbox') return send(200, await remote('/v1/assistant/inbox'));
            if (request.method === 'GET' && path === '/api/reminders') return send(200, await remote('/v1/assistant/reminders'));
            if (request.method === 'GET' && path === '/api/connections') return send(200, await remote('/v1/connections'));
            if (request.method === 'GET' && /^\/api\/tasks\/[a-f0-9-]{36}$/u.test(path)) return send(200, await remote(path.replace('/api/tasks/', '/v1/tasks/')));
            let body = '';
            for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 12000) throw error('输入过长。', 413); }
            const input = JSON.parse(body || '{}');
            if (request.method === 'POST' && path === '/api/shutdown') { send(200, { closed: true }); setTimeout(() => { void closeClient(); }, 50); return; }
            if (request.method === 'POST' && /^\/api\/work\/[a-f0-9-]{36}\/review$/u.test(path)) return send(200, await remote(path.replace('/api/work/', '/v1/work/'), 'POST', input));
            if (request.method === 'POST' && path === '/api/open-default') return send(200, await openDefault());
            if (request.method === 'POST' && /^\/api\/inbox\/[a-f0-9-]{36}\/read$/u.test(path)) return send(200, await remote(path.replace('/api/inbox/', '/v1/assistant/inbox/'), 'POST', {}));
            if (request.method === 'POST' && ['/api/activate', '/api/register', '/api/login'].includes(path)) {
                if (opening || native) throw error('请先关闭当前 Harness。', 409);
                opening = true;
                let activation;
                try {
                    if (typeof input.deviceName !== 'string' || !input.deviceName.trim()) throw error('请填写电脑名称。');
                    const login = path === '/api/login', register = path === '/api/register';
                    if (login ? typeof input.username !== 'string' || !input.username : typeof input.code !== 'string' || !input.code) throw error(login ? '请填写员工账号。' : '请填写一次性接入码。');
                    if ((login || register) && (typeof input.password !== 'string' || !input.password || input.password.length > 128 || register && input.password.length < 12)) throw error('请填写密码；设置新密码时须为12至128个字符。');
                    if (accessToken && (await state()).authenticated) throw error('这台电脑已经激活，请先退出登录。', 409);
                    const fields = login ? { username: input.username, password: input.password } : { code: input.code, ...(register ? { password: input.password } : {}) };
                    activation = await remote('/v1/employee/' + (login ? 'login' : register ? 'register' : 'activate'), 'POST', { ...fields, deviceName: input.deviceName.trim() }, undefined);
                    const encryptedToken = await protection.encrypt(activation.accessToken);
                    const next = { serverURL, employee: activation.employee, deviceId: activation.deviceId, expiresAt: activation.expiresAt, encryptedToken };
                    await writeFile(identityPath + '.tmp', JSON.stringify(next), { mode: 0o600 });
                    await rename(identityPath + '.tmp', identityPath);
                    identity = next; accessToken = activation.accessToken;
                } catch (e) { if (activation) await remote('/v1/employee/logout', 'POST', {}, activation.accessToken).catch(() => {}); throw e; }
                finally { opening = false; }
                return send(201, await state());
            }
            if (request.method === 'POST' && path === '/api/open') return send(200, await openNative(input.agentId));
            if (request.method === 'POST' && path === '/api/close') {
                if (opening) throw error('正在处理其他操作，请稍候。', 409);
                opening = true;
                try { await stopNative(); return send(200, { closed: true }); }
                finally { opening = false; }
            }
            if (request.method === 'POST' && path === '/api/logout') {
                if (opening) throw error('请等待当前操作结束。', 409);
                opening = true;
                try {
                    await stopNative();
                    if (accessToken) { try { await remote('/v1/employee/logout', 'POST', {}); } catch (e) { if (e.status !== 401) throw e; } }
                    await unlink(identityPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
                    identity = undefined; accessToken = undefined;
                    return send(200, { signedOut: true });
                } finally { opening = false; }
            }
            throw error('接口不存在。', 404);
        } catch (e) { send(e.status ?? 500, { error: { message: e.status ? e.message : '本机操作未完成，请检查公司服务连接或客户端版本。' } }); }
    });
    // A stable per-device loopback bind is also the process exclusion lock.
    const port = 30000 + parseInt(createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 4), 16) % 20000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    origin = 'http://127.0.0.1:' + server.address().port;
    const closeClient = () => closing ??= (async () => { while (opening) await new Promise(resolve => setTimeout(resolve, 50)); await stopNative(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); })();
    return { session, origin, url: origin + '/#session=' + session, openDefault, close: closeClient };
}
