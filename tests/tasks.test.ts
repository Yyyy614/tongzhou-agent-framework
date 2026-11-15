import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { TaskQueue } from '../src/tasks.js';
test('pg-boss keeps queued tasks across restart, deduplicates admission and reports actual completion', async () => {
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/tasks-'));
    const host = await createFramework({ root });
    let executed = 0;
    const executor = { async run(request: any) { executed++; const receipt = await host.invoke({ ...request, toolRef: '@example/conformance:text.normalize', input: { text: request.prompt }, idempotencyKey: 'task:' + request.idempotencyKey }); return { id: receipt.runId, state: 'succeeded', output: (receipt.output as any).text }; } };
    let queue = new TaskQueue(host, executor);
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'alice', companyId: 'example', role: 'employee', permissions: ['tool.invoke:@example/conformance:text.normalize'] });
        await host.putAgent({ id: 'worker', companyId: 'example', ownerId: 'alice', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: ['@example/conformance:text.normalize'] });
        await queue.open();
        const request = { principalId: 'alice', agentId: 'worker', prompt: '  persisted   job  ', idempotencyKey: 'one' };
        const task = await queue.submit(request);
        expect(task.state).toBe('queued');
        expect((await queue.submit(request)).id).toBe(task.id);
        await queue.close();
        queue = new TaskQueue(host, executor);
        await queue.open();
        await queue.startWorker();
        await expect.poll(async () => (await queue.get(task.id, 'alice')).state, { timeout: 10000, interval: 100 }).toBe('succeeded');
        const finished = await queue.get(task.id, 'alice');
        expect(finished.output).toBe('persisted job');
        expect(executed).toBe(1);
        await expect(queue.submit({ ...request, prompt: 'changed' })).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    finally {
        await queue.close();
        await host.close();
    }
}, 30000);
