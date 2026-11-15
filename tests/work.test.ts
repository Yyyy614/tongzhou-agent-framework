import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AdmissionBusyError } from '../src/errors.js';

test('revocation during busy admission prevents the queued work from entering later', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/work-admission-')) });
    const app = await createServer(host);
    let calls = 0, entered!: () => void;
    const busy = new Promise<void>(r => entered = r);
    const queue = new TaskQueue(host, { async run() { calls++; if (calls === 1) { entered(); throw new AdmissionBusyError('BUSY', 'busy fixture'); } return { id: randomUUID(), state: 'succeeded', output: 'must not execute' }; } });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'lead', companyId: 'one', role: 'employee', permissions: ['team.read', 'team.dispatch'], teamScope: 'direct' });
        await host.putActor({ id: 'alice', companyId: 'one', role: 'employee', permissions: [], managerId: 'lead' });
        await host.putAgent({ id: 'alice-agent', companyId: 'one', ownerId: 'alice', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        await queue.open(); queue.registerRoutes(app);
        const work = await host.coordination!.create('lead', { title: 'admission race', idempotencyKey: 'busy', assignments: [{ agentId: 'alice-agent', prompt: 'inspect' }] });
        await queue.startWorker(); await busy;
        await host.putActor({ id: 'alice', companyId: 'one', role: 'employee', permissions: [], managerId: null });
        await expect.poll(async () => (await host.db.pool.query('SELECT state FROM tasks WHERE id=$1', [work.assignments[0]!.taskId])).rows[0].state, { timeout: 10000 }).toBe('failed');
        expect(calls).toBe(1);
    } finally { await queue.close(); await app.close(); await host.close(); }
});
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { TaskQueue } from '../src/tasks.js';

test('a team leader dispatches atomic parallel work under employee identities, aggregates results and explicitly reviews them', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/work-')) });
    const app = await createServer(host);
    const executedBy: string[] = [];
    let active = 0, maximum = 0;
    const queue = new TaskQueue(host, { async run(request) {
        executedBy.push(request.principalId); active++; maximum = Math.max(maximum, active);
        const memory = await host.readMemory({ principalId: request.principalId, agentId: request.agentId, noteId: 'INDEX' });
        expect(memory.markdown).toContain('PRIVATE-');
        await new Promise(done => setTimeout(done, 300)); active--;
        return { id: randomUUID(), state: 'succeeded', output: 'Completed public work for ' + request.agentId };
    } });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'admin', companyId: 'one', role: 'admin', permissions: [] });
        await host.putActor({ id: 'chief', companyId: 'one', role: 'employee', teamScope: 'subtree', permissions: ['team.read', 'team.dispatch', 'team.review'] });
        for (const [id, companyId, managerId] of [['alice', 'one', 'chief'], ['bob', 'one', 'chief'], ['foreign', 'two', null]] as const) {
            await host.putActor({ id, companyId, role: 'employee', managerId, permissions: [] });
            await host.putAgent({ id: id + '-agent', ownerId: id, companyId, pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
            await host.writeMemory({ principalId: id, agentId: id + '-agent', noteId: 'INDEX', expectedVersion: 0, sourceRefs: [], markdown: 'PRIVATE-' + id });
        }
        await queue.open(); queue.registerRoutes(app);
        const chief = { authorization: 'Bearer ' + await host.issueAccessToken('chief') };
        const alice = { authorization: 'Bearer ' + await host.issueAccessToken('alice') };
        const foreign = { authorization: 'Bearer ' + await host.issueAccessToken('foreign') };
        const payload = { title: '通用并行验证', idempotencyKey: 'work-one', assignments: [{ agentId: 'alice-agent', prompt: '完成甲部分并只返回工作摘要' }, { agentId: 'bob-agent', prompt: '完成乙部分并只返回工作摘要' }] };
        const response = await app.inject({ method: 'POST', url: '/v1/work', headers: chief, payload });
        expect(response.statusCode).toBe(202);
        const id = response.json().id;
        expect((await app.inject({ method: 'POST', url: '/v1/work', headers: chief, payload })).json().id).toBe(id);
        expect((await host.db.pool.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n).toBe(2);
        expect((await app.inject({ method: 'POST', url: '/v1/work', headers: alice, payload: { ...payload, idempotencyKey: 'denied' } })).statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: '/v1/work', headers: chief, payload: { ...payload, idempotencyKey: 'atomic-denied', assignments: [payload.assignments[0], { agentId: 'foreign-agent', prompt: 'must not queue either child' }] } })).statusCode).toBe(403);
        expect((await host.db.pool.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n).toBe(2);
        await queue.startWorker();
        await expect.poll(async () => (await app.inject({ url: '/v1/work/' + id, headers: chief })).json().state, { timeout: 10000 }).toBe('waiting_review');
        const completed = (await app.inject({ url: '/v1/work/' + id, headers: chief })).json();
        expect(maximum).toBeGreaterThanOrEqual(2);
        expect(executedBy.sort()).toEqual(['alice', 'bob']);
        expect(completed.counts.succeeded).toBe(2);
        expect(JSON.stringify(completed)).not.toContain('PRIVATE-');
        expect((await app.inject({ url: '/v1/work/' + id, headers: alice })).json().assignments).toHaveLength(1);
        expect((await app.inject({ url: '/v1/work/' + id, headers: foreign })).statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: '/v1/work/' + id + '/review', headers: alice, payload: { revision: completed.revision, decision: 'approve', reason: 'self approval is forbidden' } })).statusCode).toBe(403);
        const reviewed = await app.inject({ method: 'POST', url: '/v1/work/' + id + '/review', headers: chief, payload: { revision: completed.revision, decision: 'approve', reason: '人工核对结果完整' } });
        expect(reviewed.statusCode).toBe(200);
        expect(reviewed.json().state).toBe('completed');
        expect((await app.inject({ method: 'POST', url: '/v1/work/' + id + '/review', headers: chief, payload: { revision: completed.revision, decision: 'approve', reason: '人工核对结果完整' } })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/v1/work/' + id + '/review', headers: chief, payload: { revision: completed.revision, decision: 'reject', reason: 'stale competing review must not overwrite the decision' } })).statusCode).toBe(409);
        expect((await app.inject({ url: '/v1/agents/alice-agent/memory/INDEX', headers: chief })).statusCode).toBe(403);
    } finally { await queue.close(); await app.close(); await host.close(); }
});

test('queued work rechecks hierarchy before execution, preserves partial failure and refuses premature approval', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/work-revoked-')) });
    const app = await createServer(host);
    const executed: string[] = [];
    const queue = new TaskQueue(host, { async run(request) { executed.push(request.principalId); return { id: randomUUID(), state: 'succeeded', output: 'safe result' }; } });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'chief', companyId: 'one', role: 'employee', teamScope: 'subtree', permissions: ['team.read', 'team.dispatch', 'team.review'] });
        await host.putActor({ id: 'peer', companyId: 'one', role: 'employee', permissions: [] });
        for (const id of ['alice', 'bob']) {
            await host.putActor({ id, companyId: 'one', role: 'employee', managerId: 'chief', permissions: [] });
            await host.putAgent({ id: id + '-agent', ownerId: id, companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        }
        await queue.open(); queue.registerRoutes(app);
        const headers = { authorization: 'Bearer ' + await host.issueAccessToken('chief') };
        const work = (await app.inject({ method: 'POST', url: '/v1/work', headers, payload: { title: '权限撤销验证', idempotencyKey: 'revoke', assignments: [{ agentId: 'alice-agent', prompt: 'must not execute after reassignment' }, { agentId: 'bob-agent', prompt: 'may execute' }] } })).json();
        expect((await app.inject({ method: 'POST', url: '/v1/work/' + work.id + '/review', headers, payload: { revision: work.revision, decision: 'approve', reason: 'too early' } })).statusCode).toBe(409);
        await host.putActor({ id: 'alice', companyId: 'one', role: 'employee', managerId: 'peer', permissions: [] });
        await queue.startWorker();
        await expect.poll(async () => (await host.db.pool.query("SELECT state FROM tasks WHERE agent_id='alice-agent'")).rows[0].state, { timeout: 10000 }).toBe('failed');
        await expect.poll(async () => (await host.db.pool.query("SELECT state FROM tasks WHERE agent_id='bob-agent'")).rows[0].state, { timeout: 10000 }).toBe('succeeded');
        const result = (await app.inject({ url: '/v1/work/' + work.id, headers })).json();
        expect(result.state).toBe('needs_attention');
        expect(result.restrictedAssignments).toBe(1);
        expect(result.assignments).toHaveLength(1);
        expect(executed).toEqual(['bob']);
        expect((await app.inject({ url: '/v1/tasks/' + work.assignments.find((a: any) => a.ownerId === 'alice').taskId, headers })).statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: '/v1/work/' + work.id + '/review', headers, payload: { revision: result.revision, decision: 'approve', reason: 'cannot accept failed work' } })).statusCode).toBe(403);
    } finally { await queue.close(); await app.close(); await host.close(); }
});
