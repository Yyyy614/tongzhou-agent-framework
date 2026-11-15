import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { TaskQueue } from '../src/tasks.js';

test('the bot entry binds the authenticated employee, deduplicates delivery and shares existing task isolation', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/bot-')) });
    const app = await createServer(host);
    const queue = new TaskQueue(host, { async run(request) { return { id: '00000000-0000-4000-8000-000000000001', state: 'succeeded', output: request.prompt }; } });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'alice', companyId: 'one', role: 'employee', permissions: [] });
        await host.putActor({ id: 'bob', companyId: 'one', role: 'employee', permissions: [] });
        for (const [id, ownerId] of [['worker', 'alice'], ['another', 'alice'], ['other', 'bob']]) await host.putAgent({ id: id!, ownerId: ownerId!, companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        await queue.open(); queue.registerRoutes(app);
        const headers = { authorization: 'Bearer ' + await host.issueAccessToken('alice') };
        const message = { agentId: 'worker', conversationId: 'local-session', messageId: 'msg-1', text: '整理本人负责的工作' };
        const deliveries = await Promise.all(Array.from({length: 6}, () => app.inject({ method: 'POST', url: '/v1/bot/messages', headers, payload: message })));
        const first = deliveries[0]!;
        expect(first.statusCode).toBe(202);
        expect(deliveries.map(r => r.statusCode)).toEqual([202,202,202,202,202,202]);
        expect(new Set(deliveries.map(r=>r.json().id)).size).toBe(1);
        expect(first.json().principalId).toBe('alice');
        expect((await app.inject({ method: 'POST', url: '/v1/bot/messages', headers, payload: message })).json().id).toBe(first.json().id);
        for (const changed of [{ ...message, text: 'changed' }, { ...message, agentId: 'another' }]) expect((await app.inject({ method: 'POST', url: '/v1/bot/messages', headers, payload: changed })).statusCode).toBe(409);
        expect((await app.inject({ method: 'POST', url: '/v1/bot/messages', headers, payload: { ...message, messageId: 'msg-2', agentId: 'other' } })).statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: '/v1/bot/messages', headers, payload: { ...message, principalId: 'bob' } })).statusCode).toBe(400);
        expect((await app.inject({ method: 'POST', url: '/v1/bot/messages', payload: message })).statusCode).toBe(401);
        await queue.startWorker();
        await expect.poll(async () => (await queue.get(first.json().id, 'alice')).state, { timeout: 10000 }).toBe('succeeded');
        const result = (await app.inject({ url: '/v1/tasks/' + first.json().id, headers })).json();
        expect(result.output).toBe(message.text);
        expect((await host.db.pool.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n).toBe(1);
    } finally { await queue.close(); await app.close(); await host.close(); }
}, 30000);
