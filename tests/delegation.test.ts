import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { TaskQueue } from '../src/tasks.js';
test('coordination dispatches parallel owner-scoped jobs and returns summaries without inheriting private memory', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/delegate-')) });
    let active = 0, maxActive = 0;
    const executedBy: string[] = [];
    const executor = { async run(request: any) { executedBy.push(request.principalId); active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 250)); const note = await host.readMemory({ ...request, noteId: 'INDEX' }); active--; return { id: crypto.randomUUID(), state: 'succeeded', output: 'Summary for ' + request.agentId }; } };
    const queue = new TaskQueue(host, executor);
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        for (const id of ['alice', 'bob', 'coordinator'])
            await host.putActor({ id, companyId: 'example', role: 'employee', permissions: id === 'coordinator' ? ['agent.execute:a', 'agent.execute:b', 'agent.read:a', 'agent.read:b'] : [] });
        for (const [id, owner] of [['a', 'alice'], ['b', 'bob'], ['coord', 'coordinator']]) {
            await host.putAgent({ id: id!, ownerId: owner!, companyId: 'example', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
            await host.writeMemory({ principalId: owner!, agentId: id!, noteId: 'INDEX', markdown: 'PRIVATE-' + id, expectedVersion: 0, sourceRefs: [] });
        }
        await queue.open();
        const parent = await queue.submit({ principalId: 'coordinator', agentId: 'coord', prompt: 'coordinate', idempotencyKey: 'parent' });
        const childA = await queue.submit({ principalId: 'coordinator', agentId: 'a', prompt: 'work a', idempotencyKey: 'a', parentTaskId: parent.id });
        const childB = await queue.submit({ principalId: 'coordinator', agentId: 'b', prompt: 'work b', idempotencyKey: 'b', parentTaskId: parent.id });
        await expect(queue.submit({ principalId: 'coordinator', agentId: 'a', prompt: 'too deep', idempotencyKey: 'deep', parentTaskId: childA.id })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        await queue.startWorker();
        await expect.poll(async () => (await queue.get(childA.id, 'coordinator')).state, { timeout: 10000 }).toBe('succeeded');
        await expect.poll(async () => (await queue.get(childB.id, 'coordinator')).state, { timeout: 10000 }).toBe('succeeded');
        expect(maxActive).toBeGreaterThanOrEqual(2);
        expect(executedBy).toContain('alice');
        expect(executedBy).toContain('bob');
        expect(JSON.stringify(await queue.summaries('a', 'coordinator'))).not.toContain('PRIVATE-a');
        await expect(host.readMemory({ principalId: 'coordinator', agentId: 'a', noteId: 'INDEX' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    finally {
        await queue.close();
        await host.close();
    }
});
