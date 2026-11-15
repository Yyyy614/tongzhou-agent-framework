import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { TaskQueue } from '../src/tasks.js';

test('work returns control facts and authorized evidence instead of a raw output prefix', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/result-')) });
    const app = await createServer(host); let queue: TaskQueue | undefined;
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'admin', companyId: 'one', role: 'admin', permissions: [] });
        for (const id of ['alice', 'bob']) await host.putActor({ id, companyId: 'one', role: 'employee', permissions: [] });
        await host.putAgent({ id: 'job', ownerId: 'alice', companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        const evidence = await host.resources.create('alice', { title: 'Explicit deliverable', domain: 'validation', kind: 'artifact', body: 'Verified independent evidence', access: { scope: 'personal', readerIds: ['admin'] }, idempotencyKey: 'evidence' });
        const privateEvidence = await host.resources.create('alice', { title: 'Private material', domain: 'validation', kind: 'document', body: 'PRIVATE-MATERIAL', access: { scope: 'personal', readerIds: [] }, idempotencyKey: 'private' });
        queue = new TaskQueue(host, { async run() { return { id: randomUUID(), state: 'succeeded', output: 'PROCESS-NOISE-'.repeat(400), report: { facts: [{ text: 'Necessary verified fact', refs: [{ id: evidence.id, version: 1 }] }, { text: 'PRIVATE-FACT', refs: [{ id: privateEvidence.id, version: 1 }] }], artifacts: [{ id: evidence.id, version: 1 }], issues: ['Needs human validation'] } }; } });
        await queue.open(); queue.registerRoutes(app); await queue.startWorker();
        const work = await host.coordination!.create('admin', { title: 'Generic result validation', idempotencyKey: 'one', assignments: [{ agentId: 'job', prompt: 'Return structured facts' }] });
        await expect.poll(async () => (await host.coordination!.get('admin', work.id)).state, { timeout: 12000 }).toBe('waiting_review');
        const view: any = await host.coordination!.get('admin', work.id);
        expect(view.assignments[0].summary).toContain('Necessary verified fact');
        expect(JSON.stringify(view)).not.toContain('PROCESS-NOISE'); expect(JSON.stringify(view)).not.toContain('PRIVATE-FACT');
        const result = await app.inject({ url: '/v1/tasks/' + view.assignments[0].taskId + '/result', headers: { authorization: 'Bearer ' + await host.issueAccessToken('admin') } });
        expect(result.statusCode).toBe(200); expect(result.json().control.state).toBe('succeeded');
        expect(result.json().facts).toHaveLength(1); expect(result.json().artifacts[0]).toMatchObject({ id: evidence.id, version: 1 });
        expect(result.json().processAvailable).toBe(false);
        const detail = await queue.get(view.assignments[0].taskId, 'admin');
        expect(JSON.stringify(detail)).not.toContain('PROCESS-NOISE');
        expect(detail.output).toBeUndefined();
        expect(detail.result.summary).toContain('Necessary verified fact');
        expect(JSON.stringify(await queue.summaries('job', 'admin'))).not.toContain('PROCESS-NOISE');
        const own = await app.inject({ url: '/v1/tasks/' + view.assignments[0].taskId + '/result', headers: { authorization: 'Bearer ' + await host.issueAccessToken('alice') } });
        expect(own.json().facts).toHaveLength(2); expect(own.json().processAvailable).toBe(true);
        const denied = await app.inject({ url: '/v1/tasks/' + view.assignments[0].taskId + '/result', headers: { authorization: 'Bearer ' + await host.issueAccessToken('bob') } });
        expect(denied.statusCode).toBe(403);
    } finally { await queue?.close(); await app.close(); await host.close(); }
});
