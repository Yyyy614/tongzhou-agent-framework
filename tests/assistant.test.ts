import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { TaskQueue } from '../src/tasks.js';
import { randomUUID } from 'node:crypto';

test('durable reminders reach only the assigned employee inbox, once across a host restart', async () => {
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/assistant-'));
    let host = await createFramework({ root });
    let app = await createServer(host);
    let queue = new TaskQueue(host, { async run() { throw Error('A reminder must not invoke a model'); } });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        for (const id of ['alice', 'bob']) {
            await host.putActor({ id, companyId: 'one', role: 'employee', permissions: ['reminder.write', 'inbox.self.read', 'event.self.publish'] });
            await host.putAgent({ id: id + '-agent', ownerId: id, companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        }
        await queue.open(); queue.registerRoutes(app);
        const alice = { authorization: 'Bearer ' + await host.issueAccessToken('alice') };
        const bob = { authorization: 'Bearer ' + await host.issueAccessToken('bob') };
        const payload = { agentId: 'alice-agent', title: '通用到期提醒', details: '处理本人待办并查看关联记录', subjectRef: { system: 'fixture', id: 'object-1' }, dueAt: new Date(Date.now() - 1000).toISOString(), idempotencyKey: 'reminder-one' };
        const response = await app.inject({ method: 'POST', url: '/v1/assistant/reminders', headers: alice, payload });
        expect(response.statusCode).toBe(201);
        expect((await app.inject({ method: 'POST', url: '/v1/assistant/reminders', headers: alice, payload: { ...payload, idempotencyKey: 'ambiguous-time', dueAt: '2026-12-01T09:00:00' } })).statusCode).toBe(400);
        const id = response.json().id;
        expect((await app.inject({ method: 'POST', url: '/v1/assistant/reminders', headers: alice, payload })).json().id).toBe(id);
        expect((await app.inject({ method: 'POST', url: '/v1/assistant/reminders', headers: alice, payload: { ...payload, title: 'changed' } })).statusCode).toBe(409);
        expect((await app.inject({ method: 'POST', url: '/v1/assistant/reminders', headers: alice, payload: { ...payload, idempotencyKey: 'denied', agentId: 'bob-agent' } })).statusCode).toBe(403);
        const cancelled = (await app.inject({ method: 'POST', url: '/v1/assistant/reminders', headers: alice, payload: { ...payload, idempotencyKey: 'cancel-one' } })).json();
        expect((await app.inject({ method: 'POST', url: '/v1/assistant/reminders/' + cancelled.id + '/cancel', headers: alice, payload: {} })).statusCode).toBe(200);
        await app.close(); await queue.close(); await host.close();
        host = await createFramework({ root }); app = await createServer(host);
        queue = new TaskQueue(host, { async run() { throw Error('A reminder must not invoke a model'); } });
        await queue.open(); queue.registerRoutes(app);
        await Promise.all([host.assistant!.runOnce(), host.assistant!.runOnce()]);
        await host.assistant!.runOnce();
        const inbox = (await app.inject({ url: '/v1/assistant/inbox', headers: alice })).json();
        expect(inbox).toHaveLength(1);
        expect(inbox[0]).toMatchObject({ kind: 'reminder.due', data: { reminderId: id, title: '通用到期提醒', subjectRef: { system: 'fixture', id: 'object-1' } } });
        expect((await app.inject({ url: '/v1/assistant/inbox', headers: bob })).json()).toHaveLength(0);
        expect((await app.inject({ method: 'POST', url: '/v1/assistant/inbox/' + inbox[0].id + '/read', headers: bob, payload: {} })).statusCode).toBe(404);
        expect((await app.inject({ method: 'POST', url: '/v1/assistant/inbox/' + inbox[0].id + '/read', headers: alice, payload: {} })).statusCode).toBe(200);
        expect((await app.inject({ url: '/v1/assistant/inbox', headers: alice })).json()[0].readAt).toBeTruthy();
        const pending = await Promise.all(Array.from({ length: 12 }, (_, i) => app.inject({ method: 'POST', url: '/v1/assistant/reminders', headers: alice, payload: { ...payload, dueAt: '2099-01-01T09:00:00Z', idempotencyKey: 'concurrent-cancel-' + i } })));
        expect(pending.map(r => r.statusCode)).toEqual(Array(12).fill(201));
        const cancellations = await Promise.all(pending.map(r => app.inject({ method: 'POST', url: '/v1/assistant/reminders/' + r.json().id + '/cancel', headers: alice, payload: {} })));
        expect(cancellations.map(r => r.statusCode)).toEqual(Array(12).fill(200));
    } finally { await app.close(); await queue.close(); await host.close(); }
});

test('automatic assistance is bounded to one attempt and never replays an unknown result', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/assistant-bounded-')) });
    const app = await createServer(host);
    let executions = 0;
    const queue = new TaskQueue(host, { async run(request) { executions++; return { id: randomUUID(), state: request.prompt === 'unknown outcome' ? 'reconciliation_required' : 'failed', output: '需要核对' }; } });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'admin', companyId: 'one', role: 'admin', permissions: [] });
        await host.putActor({ id: 'alice', companyId: 'one', role: 'employee', permissions: ['inbox.self.read'] });
        await host.putAgent({ id: 'alice-agent', companyId: 'one', ownerId: 'alice', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        await queue.open(); queue.registerRoutes(app);
        const admin = { authorization: 'Bearer ' + await host.issueAccessToken('admin') };
        expect((await app.inject({ method: 'POST', url: '/v1/admin/assistant/rules', headers: admin, payload: { id: 'handle-failure', eventType: 'work.task_failed', sourcePrincipalIds: ['alice'], enabled: true, assignments: [{ agentId: 'alice-agent', prompt: 'one bounded assistance attempt' }] } })).statusCode).toBe(201);
        for (const prompt of ['known failure', 'unknown outcome']) expect((await app.inject({ method: 'POST', url: '/v1/work', headers: admin, payload: { title: prompt, idempotencyKey: prompt, assignments: [{ agentId: 'alice-agent', prompt }] } })).statusCode).toBe(202);
        await queue.startWorker();
        await expect.poll(async () => (await host.db.pool.query("SELECT count(*)::int AS n FROM tasks WHERE state IN ('failed','reconciliation_required')")).rows[0].n, { timeout: 10000 }).toBe(2);
        await host.assistant!.runOnce(); await host.assistant!.runOnce();
        await expect.poll(async () => (await host.db.pool.query("SELECT count(*)::int AS n FROM tasks WHERE state IN ('failed','reconciliation_required')")).rows[0].n, { timeout: 10000 }).toBe(3);
        for (let i = 0; i < 4; i++) await host.assistant!.runOnce();
        expect(executions).toBe(3);
        expect((await host.db.pool.query('SELECT count(*)::int AS n FROM assistant_events')).rows[0].n).toBe(1);
        expect((await host.db.pool.query('SELECT count(*)::int AS n FROM work_items')).rows[0].n).toBe(3);
        const works=(await app.inject({ url: '/v1/work', headers: admin })).json();
        expect(works.find((w:any)=>w.title==='unknown outcome').state).toBe('reconciliation_required');
        expect(works.filter((w:any)=>w.title!=='unknown outcome').every((w:any)=>w.state==='needs_attention')).toBe(true);
    } finally { await queue.close(); await app.close(); await host.close(); }
});

test('an explicitly scoped event rule starts an employee-owned assistance task and leaves the result for human review', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/assistant-events-')) });
    const app = await createServer(host);
    const executed: string[] = [];
    const queue = new TaskQueue(host, { async run(request) { executed.push(request.principalId); return { id: randomUUID(), state: 'succeeded', output: '已完成授权范围内的检查，处理结果供人工核对' }; } });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'admin', companyId: 'one', role: 'admin', permissions: [] });
        for (const id of ['alice', 'bob']) {
            await host.putActor({ id, companyId: 'one', role: 'employee', permissions: ['event.self.publish', 'inbox.self.read'] });
            await host.putAgent({ id: id + '-agent', ownerId: id, companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        }
        await queue.open(); queue.registerRoutes(app);
        const admin = { authorization: 'Bearer ' + await host.issueAccessToken('admin') };
        const alice = { authorization: 'Bearer ' + await host.issueAccessToken('alice') };
        const bob = { authorization: 'Bearer ' + await host.issueAccessToken('bob') };
        const rule = { id: 'work-assist', eventType: 'work.issue', sourcePrincipalIds: ['alice'], enabled: true, assignments: [{ agentId: 'alice-agent', prompt: '检查关联问题并形成可核对的结果，只使用已授权工具' }] };
        for (let i = 0; i < 8; i++) expect((await app.inject({ method: 'POST', url: '/v1/admin/assistant/rules', headers: admin, payload: { ...rule, id: 'a-other-source-' + i, sourcePrincipalIds: ['bob'] } })).statusCode).toBe(201);
        expect((await app.inject({ method: 'POST', url: '/v1/admin/assistant/rules', headers: admin, payload: rule })).statusCode).toBe(201);
        expect((await app.inject({ url: '/v1/admin/assistant/rules', headers: alice })).statusCode).toBe(403);
        const payload = { agentId: 'alice-agent', type: 'work.issue', summary: '本人工作中有一项问题需要辅助检查', subjectRef: { system: 'fixture', id: 'issue-one' }, idempotencyKey: 'event-one' };
        expect((await app.inject({ method: 'POST', url: '/v1/assistant/events', headers: alice, payload: { ...payload, type: 'work.task_failed', idempotencyKey: 'spoof-system-event' } })).statusCode).toBe(400);
        const event = await app.inject({ method: 'POST', url: '/v1/assistant/events', headers: alice, payload });
        expect(event.statusCode).toBe(202);
        const eventId = event.json().id;
        expect((await app.inject({ method: 'POST', url: '/v1/assistant/events', headers: alice, payload })).json().id).toBe(eventId);
        expect((await app.inject({ method: 'POST', url: '/v1/assistant/events', headers: alice, payload: { ...payload, summary: 'changed' } })).statusCode).toBe(409);
        expect((await app.inject({ method: 'POST', url: '/v1/assistant/events', headers: alice, payload: { ...payload, createdBy: 'admin' } })).statusCode).toBe(400);
        expect((await app.inject({ method: 'POST', url: '/v1/assistant/events', headers: bob, payload: { ...payload, type: 'work.unmatched', agentId: 'bob-agent' } })).statusCode).toBe(202);
        await host.assistant!.runOnce(); await host.assistant!.runOnce();
        expect((await host.db.pool.query('SELECT count(*)::int AS n FROM work_items')).rows[0].n).toBe(1);
        const workId = (await host.db.pool.query('SELECT id FROM work_items')).rows[0].id;
        await queue.startWorker();
        await expect.poll(async () => (await app.inject({ url: '/v1/work/' + workId, headers: admin })).json().state, { timeout: 10000 }).toBe('waiting_review');
        expect(executed).toEqual(['alice']);
        await host.assistant!.runOnce(); await host.assistant!.runOnce();
        const notifications = (await app.inject({ url: '/v1/assistant/inbox', headers: admin })).json();
        expect(notifications.filter((n: any) => n.kind === 'work.review_required' && n.data.workId === workId)).toHaveLength(1);
        const candidate = (await app.inject({ url: '/v1/work/' + workId, headers: admin })).json();
        expect(candidate.review).toBeNull();
        expect((await app.inject({ method: 'POST', url: '/v1/work/' + workId + '/review', headers: admin, payload: { revision: candidate.revision, decision: 'approve', reason: '人工已核对处理结果' } })).json().state).toBe('completed');
    } finally { await app.close(); await queue.close(); await host.close(); }
});
