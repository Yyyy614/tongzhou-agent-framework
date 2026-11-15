import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { TaskQueue } from '../src/tasks.js';

test('one company source observes then routes to assigned roles, deduplicates, subscribes follow-ups and respects work stops', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/routing-')) }); let app: any, queue: TaskQueue | undefined; let executions = 0;
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        for (const [id, role, companyId] of [['admin', 'admin', 'one'], ['alice', 'employee', 'one'], ['bob', 'employee', 'one'], ['outside', 'admin', 'two']] as const) await host.putActor({ id, role, companyId, permissions: [] });
        await host.putAgent({ id: 'bob-job', ownerId: 'bob', companyId: 'one', preset: { id: 'company-worker', version: '0.1.0' }, pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        app = await createServer(host); queue = new TaskQueue(host, { async run() { executions++; return { id: randomUUID(), state: 'succeeded', output: 'confirmed event execution ' + executions }; } });
        await queue.open(); queue.registerRoutes(app);
        const headers: Record<string, any> = {}; for (const id of ['admin', 'alice', 'bob', 'outside']) headers[id] = { authorization: 'Bearer ' + await host.issueAccessToken(id) };
        const api = (actor: string, url: string, method: any = 'GET', payload?: unknown) => app.inject({ url, method, payload, headers: headers[actor] });
        const config = { name: '公司统一事件入口', enabled: true, mode: 'observe', allowedPrincipalIds: ['alice'], targets: [{ presetId: 'company-worker', eventTypes: ['validation.request'], description: '执行已授权的通用检查' }], semantic: false };
        const created = await api('admin', '/v1/admin/event-sources', 'POST', config);
        expect(created.statusCode).toBe(201); const source = created.json();
        expect((await api('alice', '/v1/admin/event-sources')).statusCode).toBe(403);
        const send = (externalEventId: string, summary: string) => api('alice', '/v1/event-sources/' + source.id + '/events', 'POST', { externalEventId, threadId: 'one-discussion', eventType: 'validation.request', summary });
        const preview = await send('preview', '只记录预期去向'); expect(preview.statusCode).toBe(202);
        await host.events.runOnce(); expect((await host.events.get('admin', preview.json().id)).state).toBe('observed');
        expect((await host.db.pool.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n).toBe(0);
        const enabled = await api('admin', '/v1/admin/event-sources/' + source.id, 'PUT', { ...config, mode: 'execute', revision: source.revision }); expect(enabled.statusCode).toBe(200);
        const first = await send('first', '开始通用检查'); expect(first.statusCode).toBe(202);
        expect((await send('first', '开始通用检查')).json().id).toBe(first.json().id);
        expect((await send('first', '伪造不同内容')).statusCode).toBe(409);
        expect((await api('outside', '/v1/event-sources/' + source.id + '/events', 'POST', { externalEventId: 'outside', threadId: 'one-discussion', eventType: 'validation.request', summary: 'not accepted' })).statusCode).toBe(404);
        await host.events.runOnce(); const routed = await host.events.get('admin', first.json().id); expect(routed.state).toBe('routed'); expect(routed.workId).toBeTruthy();
        await queue.startWorker(); await expect.poll(async () => (await host.coordination!.get('admin', routed.workId)).state, { timeout: 12000 }).toBe('waiting_review');
        const next = await send('followup', '补充当前工作所需的第二条说明'); await host.events.runOnce();
        await expect.poll(async () => (await host.events.get('admin', next.json().id)).state, { timeout: 12000 }).toBe('attached');
        await expect.poll(async () => (await host.coordination!.get('admin', routed.workId)).state, { timeout: 12000 }).toBe('waiting_review');
        const continued = await host.coordination!.get('admin', routed.workId); expect(continued.currentRound).toBe(2); expect(executions).toBe(2);
        expect((await host.db.pool.query('SELECT count(*)::int AS n FROM work_items')).rows[0].n).toBe(1);
        await host.coordination!.control.command('admin', routed.workId, { revision: continued.revision, idempotencyKey: 'stop', action: 'stop', reason: '暂停后不得自动继续' });
        const afterStop = await send('after-stop', '这条输入不得重新启动工作'); await host.events.runOnce();
        expect((await host.events.get('admin', afterStop.json().id)).state).toBe('blocked'); expect(executions).toBe(2);
        expect((await host.coordination!.get('admin', routed.workId)).currentRound).toBe(2);
    } finally { await queue?.close(); await app?.close(); await host.close(); }
});

test('semantic routing sees only bounded role candidates, observed ambiguity creates no work, and subscribed messages skip reassessment', async () => {
    await mkdir('.test-data', { recursive: true }); const host = await createFramework({ root: await mkdtemp(resolve('.test-data/semantic-route-')) });
    let app: any, queue: TaskQueue | undefined, assessments = 0;
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        for (const [id, role] of [['admin', 'admin'], ['alice', 'employee'], ['bob', 'employee'], ['charlie', 'employee']] as const) await host.putActor({ id, role, companyId: 'one', permissions: [] });
        for (const id of ['bob', 'charlie']) { await host.putAgent({ id: id + '-job', ownerId: id, companyId: 'one', preset: { id: 'company-worker', version: '0.1.0' }, pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] }); await host.writeMemory({ principalId: id, agentId: id + '-job', noteId: 'INDEX', expectedVersion: 0, markdown: 'PRIVATE-' + id, sourceRefs: [] }); }
        app = await createServer(host); queue = new TaskQueue(host, { async assessEvent(input) { assessments++; expect(JSON.stringify(input)).not.toContain('PRIVATE-'); expect(input.candidates.map(c => c.agentId).sort()).toEqual(['bob-job', 'charlie-job']); if (input.summary === 'unavailable') throw Error('provider unavailable'); return { action: 'assign', agentId: input.summary === 'outside' ? 'foreign-job' : 'bob-job', reason: 'Bounded candidate selection' }; }, async run() { return { id: randomUUID(), state: 'succeeded', output: 'confirmed' }; } });
        await queue.open(); queue.registerRoutes(app);
        const admin = { authorization: 'Bearer ' + await host.issueAccessToken('admin') }, alice = { authorization: 'Bearer ' + await host.issueAccessToken('alice') };
        const api = (url: string, method: any = 'GET', payload?: unknown, employee = false) => app.inject({ url, method, payload, headers: employee ? alice : admin });
        const config = { name: 'Shared role source', enabled: true, mode: 'observe', allowedPrincipalIds: ['alice'], semantic: false, targets: [{ presetId: 'company-worker', eventTypes: ['request'], description: '处理当前员工提交的通用工作' }] };
        const source = (await api('/v1/admin/event-sources', 'POST', config)).json();
        const send = (externalEventId: string, threadId: string, summary: string) => api('/v1/event-sources/' + source.id + '/events', 'POST', { externalEventId, threadId, eventType: 'request', summary }, true);
        const preview = await send('preview', 'preview', 'two matching roles'); await host.events.runOnce();
        expect((await host.events.get('admin', preview.json().id)).state).toBe('observed'); expect(assessments).toBe(0);
        expect((await host.db.pool.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n).toBe(0);
        await api('/v1/admin/event-sources/' + source.id, 'PUT', { ...config, mode: 'execute', semantic: true, revision: source.revision });
        const first = await send('first', 'work-thread', 'choose a role'); await host.events.runOnce(); const routed = await host.events.get('admin', first.json().id); expect(routed.state).toBe('routed'); expect(assessments).toBe(1);
        await queue.startWorker(); await expect.poll(async () => (await host.coordination!.get('admin', routed.workId)).state, { timeout: 12000 }).toBe('waiting_review');
        const follow = await send('next', 'work-thread', 'follow up on the same work'); await host.events.runOnce(); expect((await host.events.get('admin', follow.json().id)).state).toBe('attached'); expect(assessments).toBe(1);
        for (const text of ['unavailable', 'outside']) { const event = await send(text, text, text); await host.events.runOnce(); expect((await host.events.get('admin', event.json().id)).state).toBe('needs_attention'); }
        expect((await host.db.pool.query('SELECT count(*)::int AS n FROM work_items')).rows[0].n).toBe(1); expect(assessments).toBe(3);
    } finally { await queue?.close(); await app?.close(); await host.close(); }
});

test('follow-up inputs persist during execution and are consumed once after the current round ends', async () => {
    await mkdir('.test-data', { recursive: true }); const host = await createFramework({ root: await mkdtemp(resolve('.test-data/event-pending-')) });
    let app: any, queue: TaskQueue | undefined, release!: () => void, calls = 0; const gate = new Promise<void>(resolve => { release = resolve; });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        for (const [id, role] of [['admin', 'admin'], ['alice', 'employee'], ['bob', 'employee']] as const) await host.putActor({ id, role, companyId: 'one', permissions: [] });
        await host.putAgent({ id: 'bob-job', ownerId: 'bob', companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        app = await createServer(host); queue = new TaskQueue(host, { async run() { calls++; if (calls === 1) await gate; return { id: randomUUID(), state: 'succeeded', output: 'confirmed' }; } }); await queue.open(); queue.registerRoutes(app);
        const admin = { authorization: 'Bearer ' + await host.issueAccessToken('admin') }, alice = { authorization: 'Bearer ' + await host.issueAccessToken('alice') };
        const created = await app.inject({ url: '/v1/admin/event-sources', method: 'POST', headers: admin, payload: { name: 'Company source', enabled: true, mode: 'execute', allowedPrincipalIds: ['alice'], semantic: false, targets: [{ agentId: 'bob-job', eventTypes: ['request'], description: 'Generic work' }] } }); const sourceId = created.json().id;
        const send = (externalEventId: string) => app.inject({ url: '/v1/event-sources/' + sourceId + '/events', method: 'POST', headers: alice, payload: { externalEventId, threadId: 'same', eventType: 'request', summary: externalEventId } });
        const first = await send('first'); await host.events.runOnce(); const workId = (await host.events.get('admin', first.json().id)).workId;
        await queue.startWorker(); await expect.poll(() => calls).toBe(1);
        const next = await send('next'); await host.events.runOnce(); expect((await host.events.get('admin', next.json().id)).state).toBe('waiting_work'); expect(calls).toBe(1);
        release(); await expect.poll(async () => (await host.events.get('admin', next.json().id)).state, { timeout: 12000 }).toBe('attached');
        await expect.poll(async () => (await host.coordination!.get('admin', workId)).state, { timeout: 12000 }).toBe('waiting_review'); expect(calls).toBe(2);
        expect((await host.coordination!.get('admin', workId)).currentRound).toBe(2);
    } finally { release(); await queue?.close(); await app?.close(); await host.close(); }
});
