import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { TaskQueue } from '../src/tasks.js';
import { AdmissionBusyError, FrameworkError } from '../src/errors.js';
test('queued work waits for a known busy admission but never retries an uncertain execution', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/admission-')) });
    let attempts = 0, uncertainAttempts = 0;
    const queue = new TaskQueue(host, { async run(request) {
        if (request.prompt === 'uncertain') { uncertainAttempts++; throw new FrameworkError('RESULT_UNKNOWN', 'A remote receipt is missing'); }
        if (++attempts === 1) throw new AdmissionBusyError('CONFLICT', 'Native client is still working');
        return { id: '00000000-0000-4000-8000-000000000002', state: 'succeeded', output: 'accepted after busy admission' };
    } });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'alice', companyId: 'one', role: 'employee', permissions: [] });
        await host.putAgent({ id: 'worker', ownerId: 'alice', companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        await queue.open(); await queue.startWorker();
        const task = await queue.submit({ principalId: 'alice', agentId: 'worker', prompt: 'work', idempotencyKey: 'busy' });
        await expect.poll(async () => (await queue.get(task.id, 'alice')).state, { timeout: 3000 }).toBe('succeeded');
        expect(attempts).toBe(2);
        const uncertain = await queue.submit({ principalId: 'alice', agentId: 'worker', prompt: 'uncertain', idempotencyKey: 'unknown' });
        await expect.poll(async () => (await queue.get(uncertain.id, 'alice')).state, { timeout: 3000 }).toBe('reconciliation_required');
        expect(uncertainAttempts).toBe(1);
    } finally { await queue.close(); await host.close(); }
}, 10000);
