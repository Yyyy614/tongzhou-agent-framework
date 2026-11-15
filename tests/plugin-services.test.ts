import { test, expect } from 'vitest';
import { mkdtemp, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
test('a mounted plugin receives scoped memory and report services only after explicit grants', async () => {
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/services-'));
    const host = await createFramework({ root });
    try {
        const fixture = resolve(root, 'source');
        await cp(resolve('fixtures/conformance-plugin'), fixture, { recursive: true });
        await writeFile(resolve(fixture, 'dist/plugin.mjs'), `export function apply(ctx){ctx.tools.register('text.normalize',async(input,call)=>{const note=await call.services.memory.read({noteId:'INDEX'});await call.services.reports.record({summary:note.markdown});return {text:note.markdown};});}`);
        await host.installPlugin(fixture);
        const actor = { id: 'alice', companyId: 'example', role: 'employee' as const, permissions: ['tool.invoke:@example/conformance:text.normalize', 'memory.self.read', 'report.self.write'] };
        await host.putActor(actor);
        const agent = { id: 'worker', ownerId: 'alice', companyId: 'example', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: ['@example/conformance:text.normalize'] };
        await host.putAgent(agent);
        await host.writeMemory({ principalId: 'alice', agentId: 'worker', noteId: 'INDEX', markdown: 'My own notes', expectedVersion: 0, sourceRefs: [] });
        const request = { principalId: 'alice', agentId: 'worker', toolRef: '@example/conformance:text.normalize', input: { text: 'test' }, idempotencyKey: 'ungranted' };
        await expect(host.invoke(request)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        await host.putAgent({ ...agent, servicePermissions: ['memory.self.read', 'report.self.write'] });
        expect((await host.invoke({ ...request, idempotencyKey: 'granted' })).output).toEqual({ text: 'My own notes' });
        const logs = await host.listLogs({ principalId: 'alice', agentId: 'worker' });
        expect(logs.find(l => l.type === 'report.recorded')?.data.summary).toBe('My own notes');
    }
    finally {
        await host.close();
    }
});
