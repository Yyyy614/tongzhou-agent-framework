import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { TaskQueue } from '../src/tasks.js';

test('a mounted work plugin uses bound identity, effective grants and revocable dispatch authority', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/work-plugin-')) });
    const app = await createServer(host);
    const executed: string[] = [];
    const queue = new TaskQueue(host, { async run(r) { executed.push(r.principalId); return { id: randomUUID(), state: 'succeeded', output: 'authorized result' }; } });
    try {
        const plugin = await host.installPlugin(resolve('packages/work-assistant'));
        const tools = plugin.manifest.provides.tools.map(t => plugin.id + ':' + t.id);
        const grants = plugin.manifest.permissions;
        await host.putActor({ id: 'lead', companyId: 'one', role: 'employee', teamScope: 'subtree', permissions: ['team.read', 'team.dispatch', 'team.review', ...grants, ...tools.map(t => 'tool.invoke:' + t)] });
        await host.putActor({ id: 'worker', companyId: 'one', role: 'employee', managerId: 'lead', permissions: [] });
        await host.putAgent({ id: 'lead-agent', companyId: 'one', ownerId: 'lead', pluginId: plugin.id, pluginVersion: plugin.version, allowedTools: tools, servicePermissions: grants, delegates: ['worker-agent'] });
        await host.putAgent({ id: 'worker-agent', companyId: 'one', ownerId: 'worker', pluginId: plugin.id, pluginVersion: plugin.version, allowedTools: [] });
        await queue.open(); queue.registerRoutes(app);
        let n = 0;
        const invoke = (id: string, input: unknown) => host.invoke({ principalId: 'lead', agentId: 'lead-agent', toolRef: plugin.id + ':' + id, input, idempotencyKey: 'call-' + ++n });
        expect((await invoke('team.list', {})).output).toMatchObject({ members: expect.arrayContaining([expect.objectContaining({ id: 'worker' })]) });
        const work = (await invoke('work.dispatch', { title: 'bound team work', assignments: [{ agentId: 'worker-agent', prompt: 'inspect generic fixture' }] })).output as any;
        expect(work.assignments[0]).toMatchObject({ ownerId: 'worker', state: 'queued' });
        await expect(queue.submit({ principalId: 'lead', agentId: 'worker-agent', prompt: 'must not create a nested legacy task', idempotencyKey: 'nested-work', parentTaskId: work.assignments[0].taskId })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
        const reminder = (await invoke('reminder.schedule', { title: 'follow up', dueAt: new Date().toISOString(), details: 'context for the assigned employee' })).output as any;
        expect(reminder.ownerId).toBe('lead');
        await host.assistant!.runOnce();
        expect((await invoke('inbox.list', {})).output).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ kind: 'reminder.due' })]) });
        expect((await invoke('event.publish', { type: 'work.issue', summary: 'generic fixture issue' })).output).toMatchObject({ source: 'plugin:@company/work-assistant', state: 'pending' });
        await expect(invoke('work.dispatch', { principalId: 'admin', title: 'spoof', assignments: [{ agentId: 'worker-agent', prompt: 'denied' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        const lead = await host.db.get<any>('agents', 'lead-agent');
        await host.putAgent({ ...lead, servicePermissions: [] });
        await expect(invoke('inbox.list', {})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        await queue.startWorker();
        await expect.poll(async () => (await host.coordination!.get('lead', work.id)).state, { timeout: 10000 }).toBe('needs_attention');
        expect(executed).toHaveLength(0);
    } finally { await app.close(); await queue.close(); await host.close(); }
});
