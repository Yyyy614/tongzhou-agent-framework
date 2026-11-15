import { test, expect } from 'vitest';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
test('agent notes are isolated, versioned, selectively loaded and survive restart', async () => {
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/memory-'));
    let host = await createFramework({ root });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        for (const id of ['alice', 'bob']) {
            await host.putActor({ id, companyId: 'example', role: 'employee', permissions: [] });
            await host.putAgent({ id, companyId: 'example', ownerId: id, pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        }
        const note = await host.writeMemory({ principalId: 'alice', agentId: 'alice', noteId: 'INDEX', markdown: '# Index\n[[reply-rules]]', expectedVersion: 0, sourceRefs: ['manual:1'] });
        expect(note.version).toBe(1);
        await host.writeMemory({ principalId: 'alice', agentId: 'alice', noteId: 'reply-rules', markdown: 'Keep replies concise.', expectedVersion: 0, sourceRefs: ['manual:2'] });
        await expect(host.readMemory({ principalId: 'bob', agentId: 'alice', noteId: 'INDEX' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        await expect(host.writeMemory({ principalId: 'alice', agentId: 'alice', noteId: 'INDEX', markdown: 'stale', expectedVersion: 0, sourceRefs: [] })).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(host.readMemory({ principalId: 'alice', agentId: 'alice', noteId: '../bob/INDEX' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        const context = await host.buildContext({ principalId: 'alice', agentId: 'alice', noteIds: ['INDEX'], maxChars: 200 });
        expect(context.text).toContain('[[reply-rules]]');
        expect(context.text).not.toContain('Keep replies concise.');
        await host.close();
        host = await createFramework({ root });
        expect((await host.readMemory({ principalId: 'alice', agentId: 'alice', noteId: 'reply-rules' })).markdown).toBe('Keep replies concise.');
    }
    finally {
        await host.close();
    }
});
