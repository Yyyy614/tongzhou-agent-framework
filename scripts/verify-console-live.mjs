// Browser conformance of the real console against a loopback API fixture.
// Set PLAYWRIGHT_MODULE_PATH when Playwright is supplied by the host runtime.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH ?? 'playwright');
const root = resolve(import.meta.dirname, '..');
const fixture = { logs: [], requests: [], usage: { requests: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, unmeasuredRequests: 0, reportedRequests: 0 } };
const note = (noteId, version, markdown) => ({ noteId, version, markdown, sourceRefs: ['fixture'], updatedAt: '2026-11-13T12:00:00Z' });
fixture.memories = { 'worker-a': { INDEX: note('INDEX', 1, '甲的索引') }, 'worker-b': { INDEX: note('INDEX', 1, '乙的索引'), PRIVATE_TEST: note('PRIVATE_TEST', 1, '私有记忆v1') } };
const employee = id => ({ id, displayName: id, role: 'employee', companyId: 'fixture', active: true, permissions: [] });
const agent = id => ({ id, ownerId: id === 'worker-a' ? 'alice' : 'bob', displayName: id, active: true, companyId: 'fixture', allowedTools: [], pluginId: '@example/conformance', pluginVersion: '0.1.0' });
const event = (id, agentId, type, text) => ({ id, type, createdAt: new Date().toISOString(), cursor: id, data: { agentId, principalId: agentId === 'worker-a' ? 'alice' : 'bob', text } });
fixture.logs.push(event('1', 'worker-b', 'run.succeeded', 'live-probe-initial'));
const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://fixture');
        if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/console/')) {
            fixture.requests.push(url.pathname + url.search);
            if (fixture.expired) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } })); return; }
            let data;
            if (url.pathname === '/console/me') data = { id: 'admin', displayName: 'admin', companyId: 'fixture', role: 'admin' };
            else if (url.pathname === '/v1/admin/employees') data = [employee('alice'), employee('bob')];
            else if (url.pathname === '/v1/admin/agents') data = [agent('worker-a'), agent('worker-b')];
            else if (['/v1/admin/plugins', '/v1/presets', '/v1/admin/departments'].includes(url.pathname)) data = [];
            else if (url.pathname === '/v1/admin/activity') {
                const items = fixture.logs.filter(e => (!url.searchParams.get('agentId') || e.data.agentId === url.searchParams.get('agentId')) && (!url.searchParams.get('type') || e.type === url.searchParams.get('type')) && (!url.searchParams.get('q') || JSON.stringify(e).includes(url.searchParams.get('q'))) && (!url.searchParams.get('before') || Number(e.cursor) < Number(url.searchParams.get('before'))));
                data = { items: fixture.paged ? items.slice(0, 2) : items, nextCursor: fixture.paged && items.length > 2 ? items[1].cursor : null };
            }
            else if (url.pathname === '/v1/admin/usage') {
                if (fixture.usageUnavailable) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'UNAVAILABLE' } })); return; }
                const totals = url.searchParams.get('principalId') === 'alice' ? { ...fixture.usage, requests: 9 } : { ...fixture.usage };
                data = { days: Number(url.searchParams.get('days')), totals, series: [{ day: '2026-11-13', ...totals }], byEmployee: [{ principalId: url.searchParams.get('principalId') ?? 'bob', ...totals }], records: [] };
                if (url.searchParams.get('principalId') === 'bob' && fixture.holdUsage) { fixture.usageReadPending = true; await fixture.holdUsage; }
            }
            else if (/^\/v1\/agents\/worker-[ab]\/memory(?:\/[A-Z_]+)?$/u.test(url.pathname)) {
                const [, , , id, , noteId] = url.pathname.split('/');
                const space = fixture.memories[id];
                data = noteId ? structuredClone(space[noteId]) : Object.values(space).map(n => ({ ...n, excerpt: n.markdown, links: [], characters: n.markdown.length }));
                if (noteId && fixture.holdNote) { fixture.noteReadPending = true; await fixture.holdNote; }
            }
            else throw Error('Unexpected fixture API: ' + url.pathname);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(data));
        } else {
            const name = url.pathname === '/' ? 'index.html' : url.pathname.replace('/assets/', '');
            if (!/^(?:index\.html|[a-z-]+\.(?:js|mjs|css))$/u.test(name)) throw Error('Unexpected asset');
            res.writeHead(200, { 'content-type': (name.endsWith('.js') || name.endsWith('.mjs')) ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
            res.end(await readFile(resolve(root, 'web', name)));
        }
    } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'FIXTURE_ERROR', message: error.message } })); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
const page = await context.newPage();
async function eventually(check, message, timeout = 6500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await check()) return; await delay(100); }
    assert.fail(message);
}
const evidence = [];
try {
    await page.goto(origin + '/#logs');
    await page.getByLabel('日志 Agent 筛选').selectOption('worker-b');
    await page.getByLabel('日志事件筛选').selectOption('run.succeeded');
    await page.getByLabel('搜索事件、员工或运行编号').fill('live-probe');
    await page.getByRole('button', { name: '查询', exact: true }).click();
    await eventually(async () => (await page.locator('tbody').innerText()).includes('worker-b'), 'Initial filter must load');
    fixture.logs.unshift(event('2', 'worker-b', 'run.succeeded', 'live-probe-added'));
    await eventually(async () => (await page.locator('tbody tr').count()) === 2, 'New matching log must appear automatically without a manual query');
    assert.equal(await page.getByLabel('日志 Agent 筛选').inputValue(), 'worker-b');
    assert.equal(await page.getByLabel('日志事件筛选').inputValue(), 'run.succeeded');
    assert.equal(await page.getByLabel('搜索事件、员工或运行编号').inputValue(), 'live-probe');
    await page.getByRole('button', { name: '刷新页面', exact: true }).click();
    assert.equal(await page.getByLabel('日志 Agent 筛选').inputValue(), 'worker-b');
    await page.reload();
    await page.getByLabel('日志 Agent 筛选').waitFor();
    assert.equal(await page.getByLabel('日志 Agent 筛选').inputValue(), 'worker-b');
    assert.equal(await page.getByLabel('日志事件筛选').inputValue(), 'run.succeeded');
    assert.equal(await page.getByLabel('搜索事件、员工或运行编号').inputValue(), 'live-probe');
    evidence.push('New logs auto-update; filters survive automatic, manual and full reloads');
    await page.getByRole('link', { name: '模型用量', exact: true }).click();
    await page.getByLabel('用量 Agent 筛选').selectOption('worker-b');
    await page.getByLabel('用量员工筛选').selectOption('bob');
    const initialUsage = page.waitForResponse(r => r.url().includes('/v1/admin/usage?days=30&agentId=worker-b&principalId=bob'));
    await page.getByLabel('用量时间范围').selectOption('30');
    await (await initialUsage).finished();
    await eventually(async () => (await page.locator('.metric-value').first().innerText()) === '1', 'Initial filtered usage must settle before the upstream change');
    fixture.usage = { ...fixture.usage, requests: 4, inputTokens: 333, outputTokens: 33 };
    await eventually(async () => (await page.locator('.metric-value').first().innerText()) === '4', 'Measured usage must update automatically');
    await page.getByRole('button', { name: '刷新页面', exact: true }).click();
    assert.equal(await page.getByLabel('用量 Agent 筛选').inputValue(), 'worker-b');
    assert.equal(await page.getByLabel('用量员工筛选').inputValue(), 'bob');
    assert.equal(await page.getByLabel('用量时间范围').inputValue(), '30');
    await page.reload();
    await page.getByLabel('用量员工筛选').waitFor();
    assert.equal(await page.getByLabel('用量 Agent 筛选').inputValue(), 'worker-b');
    assert.equal(await page.getByLabel('用量员工筛选').inputValue(), 'bob');
    assert.equal(await page.getByLabel('用量时间范围').inputValue(), '30');
    evidence.push('Usage auto-updates and preserves employee, Agent and time range across reloads');
    await page.getByRole('link', { name: '独立记忆', exact: true }).click();
    await page.getByLabel('记忆所属 Agent').selectOption('worker-b');
    await page.getByRole('button', { name: /^PRIVATE_TEST v/ }).click();
    await eventually(async () => (await page.getByLabel('记忆 Markdown 内容').inputValue()) === '私有记忆v1', 'Initial private note must be selected');
    fixture.memories['worker-b'].PRIVATE_TEST = note('PRIVATE_TEST', 2, '来自Agent的新记忆v2');
    await eventually(async () => (await page.getByLabel('记忆 Markdown 内容').inputValue()) === '来自Agent的新记忆v2', 'Selected private note must update automatically');
    assert.equal(await page.getByLabel('记忆所属 Agent').inputValue(), 'worker-b');
    assert.equal(await page.locator('.editor-heading h2').innerText(), 'PRIVATE_TEST');
    await page.reload();
    await page.getByLabel('记忆所属 Agent').waitFor();
    await eventually(async () => await page.locator('.editor-heading h2').innerText() === 'PRIVATE_TEST', 'Reload must retain the selected private note');
    assert.equal(await page.getByLabel('记忆所属 Agent').inputValue(), 'worker-b');
    evidence.push('Selected memory automatically receives Agent updates and survives full reload');
    let releaseNote;
    fixture.holdNote = new Promise(done => { releaseNote = done; });
    fixture.memories['worker-b'].PRIVATE_TEST = note('PRIVATE_TEST', 3, '服务器新版本v3');
    await eventually(async () => fixture.noteReadPending, 'An automatic read must reach the actual HTTP boundary');
    await page.getByLabel('记忆 Markdown 内容').fill('这是不能丢失的未保存草稿');
    fixture.holdNote = undefined; releaseNote();
    await delay(250);
    assert.equal(await page.getByLabel('记忆 Markdown 内容').inputValue(), '这是不能丢失的未保存草稿');
    await page.getByRole('button', { name: '刷新页面', exact: true }).click();
    assert.equal(await page.getByLabel('记忆 Markdown 内容').inputValue(), '这是不能丢失的未保存草稿');
    await eventually(async () => (await page.locator('[data-live-status]').innerText()).includes('草稿未保存'), 'Unsaved memory must pause automatic refresh');
    const readsBeforePause = fixture.requests.filter(p => p.startsWith('/v1/agents/worker-b/memory')).length;
    await delay(3300);
    assert.equal(fixture.requests.filter(p => p.startsWith('/v1/agents/worker-b/memory')).length, readsBeforePause);
    assert.equal(await page.getByLabel('记忆 Markdown 内容').inputValue(), '这是不能丢失的未保存草稿');
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '重新读取', exact: true }).click();
    await eventually(async () => (await page.getByLabel('记忆 Markdown 内容').inputValue()) === '服务器新版本v3', 'Explicit discard must read the new version');
    fixture.memories['worker-b'].PRIVATE_TEST = note('PRIVATE_TEST', 4, '恢复自动更新v4');
    await eventually(async () => (await page.getByLabel('记忆 Markdown 内容').inputValue()) === '恢复自动更新v4', 'Automatic updates must resume after leaving draft mode');
    evidence.push('An in-flight memory response cannot overwrite a new draft; explicit discard resumes updates');
    await page.getByRole('link', { name: '日志与记录', exact: true }).click();
    await page.getByLabel('日志 Agent 筛选').waitFor();
    assert.equal(await page.getByLabel('日志 Agent 筛选').inputValue(), 'worker-b');
    assert.equal(await page.getByLabel('日志事件筛选').inputValue(), 'run.succeeded');
    const stoppedReads = fixture.requests.filter(p => p.startsWith('/v1/agents/worker-b/memory')).length;
    await delay(3300);
    assert.equal(fixture.requests.filter(p => p.startsWith('/v1/agents/worker-b/memory')).length, stoppedReads);
    evidence.push('Navigation retains filters and stops the previous view polling');
    fixture.paged = true;
    fixture.logs.push(event('0', 'worker-b', 'run.succeeded', 'live-probe-older'));
    await page.getByRole('button', { name: '查询', exact: true }).click();
    await eventually(async () => await page.getByRole('button', { name: '更早记录', exact: true }).isEnabled(), 'History cursor must be available');
    await page.getByRole('button', { name: '更早记录', exact: true }).click();
    await eventually(async () => await page.locator('tbody tr').count() === 1, 'History page must load');
    fixture.logs.unshift(event('3', 'worker-b', 'run.succeeded', 'live-probe-latest'));
    await delay(3300);
    assert.equal(await page.locator('tbody tr').count(), 1);
    assert((await page.locator('[data-live-status]').innerText()).includes('历史记录'));
    await page.reload();
    await page.getByLabel('日志 Agent 筛选').waitFor();
    await eventually(async () => await page.locator('tbody tr').count() === 1, 'Reload must retain the history cursor');
    assert.equal(await page.getByLabel('日志 Agent 筛选').inputValue(), 'worker-b');
    await page.getByRole('button', { name: '回到最新', exact: true }).click();
    await eventually(async () => await page.locator('tbody tr').count() === 2, 'Returning to latest must resume the latest query');
    evidence.push('History browsing pauses live insertion and retains the cursor across reloads');
    await page.getByRole('link', { name: '模型用量', exact: true }).click();
    await page.getByLabel('用量员工筛选').waitFor();
    let releaseUsage;
    fixture.holdUsage = new Promise(done => { releaseUsage = done; });
    await eventually(async () => fixture.usageReadPending, 'A background usage request must reach the HTTP boundary');
    await page.getByLabel('用量员工筛选').selectOption('alice');
    await eventually(async () => (await page.locator('.metric-value').first().innerText()) === '9', 'The newly selected employee must load first');
    fixture.holdUsage = undefined; releaseUsage();
    await delay(250);
    assert.equal(await page.getByLabel('用量员工筛选').inputValue(), 'alice');
    assert.equal(await page.locator('.metric-value').first().innerText(), '9');
    await page.getByLabel('用量员工筛选').selectOption('bob');
    await eventually(async () => (await page.locator('.metric-value').first().innerText()) === '4', 'Changing the filter back must restore its own data');
    evidence.push('A late background response cannot replace a newly selected employee or their usage');
    fixture.usageUnavailable = true;
    await eventually(async () => (await page.locator('[data-live-status]').innerText()).includes('连接暂不可用'), 'Failed polling must visibly retain the current data');
    assert.equal(await page.locator('.metric-value').first().innerText(), '4');
    assert.equal(await page.getByLabel('用量员工筛选').inputValue(), 'bob');
    fixture.usageUnavailable = false;
    fixture.usage = { ...fixture.usage, requests: 5 };
    await page.getByRole('button', { name: '刷新页面', exact: true }).click();
    await eventually(async () => (await page.locator('.metric-value').first().innerText()) === '5', 'A retry must recover without losing filters');
    assert.equal(await page.getByLabel('用量 Agent 筛选').inputValue(), 'worker-b');
    assert.equal(await page.getByLabel('用量员工筛选').inputValue(), 'bob');
    assert.equal(await page.getByLabel('用量时间范围').inputValue(), '30');
    evidence.push('A temporary network failure preserves data and selections, and retry recovers');
    fixture.expired = true;
    await eventually(async () => await page.getByRole('heading', { name: '打开管理工作空间', exact: true }).isVisible(), 'An expired session must leave the live view');
    const expiredRequestCount = fixture.requests.length;
    await delay(3300);
    assert.equal(fixture.requests.length, expiredRequestCount);
    evidence.push('Authentication expiry clears the live view and stops polling');
    await mkdir(resolve(root, '.local'), { recursive: true });
    await writeFile(resolve(root, '.local/console-live-browser.json'), JSON.stringify({ testedAt: new Date().toISOString(), checks: evidence }, null, 2));
    console.log(JSON.stringify({ passed: evidence }));
} finally { await context.close(); await browser.close(); await new Promise(done => server.close(done)); }
