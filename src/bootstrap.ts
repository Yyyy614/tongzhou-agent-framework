import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Framework } from './index.js';
import type { Actor } from './types.js';
export async function bootstrap(host: Framework) {
    await host.installPlugin(resolve('fixtures/conformance-plugin'));
    await host.installPlugin(resolve('packages/work-assistant'));
    await host.installPlugin(resolve('packages/connection-catalog'));
    const tool = '@example/conformance:text.normalize';
    const actors: Actor[] = [{ id: 'admin', companyId: 'reference', role: 'admin', permissions: [] }, ...['alice', 'bob'].map(id => ({ id, companyId: 'reference', role: 'employee' as const, permissions: ['tool.invoke:' + tool, 'memory.self.read', 'memory.self.propose_write', 'report.self.write'] })), { id: 'coordinator', companyId: 'reference', role: 'employee', permissions: ['agent.read:worker-a', 'agent.read:worker-b', 'agent.execute:worker-a', 'agent.execute:worker-b'] }];
    for (const actor of actors) {
        try {
            await host.db.get('actors', actor.id);
        }
        catch (e) {
            if ((e as any).code !== 'NOT_FOUND')
                throw e;
            await host.putActor(actor);
        }
    }
    for (const [id, ownerId] of [['worker-a', 'alice'], ['worker-b', 'bob']]) {
        try {
            await host.db.get('agents', id!);
        }
        catch (e) {
            if ((e as any).code !== 'NOT_FOUND')
                throw e;
            await host.putAgent({ id: id!, ownerId: ownerId!, companyId: 'reference', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [tool], servicePermissions: ['memory.self.read', 'memory.self.propose_write', 'report.self.write'], instructions: 'You are a reference worker. Use authorized tools to verify results. Read your own memory only when needed. Return concise factual results.' });
        }
        try {
            await host.readMemory({ principalId: ownerId!, agentId: id!, noteId: 'INDEX' });
        }
        catch (e) {
            if ((e as any).code !== 'NOT_FOUND')
                throw e;
            await host.writeMemory({ principalId: ownerId!, agentId: id!, noteId: 'INDEX', markdown: `# Private index\nOwner: ${ownerId}\nLoad specific linked notes only when needed.\n`, expectedVersion: 0, sourceRefs: ['bootstrap:reference'] });
        }
    }
    try {
        await host.db.get('agents', 'coordinator');
    }
    catch (e) {
        if ((e as any).code !== 'NOT_FOUND')
            throw e;
        await host.putAgent({ id: 'coordinator', ownerId: 'coordinator', companyId: 'reference', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [], delegates: ['worker-a', 'worker-b'], instructions: 'Coordinate work through delegated tasks. Receive summaries and references only. Do not request private worker memory.' });
    }
    await mkdir('.local', { recursive: true });
    let credentials: Record<string, string> = {};
    try {
        credentials = JSON.parse(await readFile('.local/access.json', 'utf8'));
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
            throw e;
    }
    for (const actor of actors)
        if (!credentials[actor.id])
            credentials[actor.id] = await host.issueAccessToken(actor.id);
    await writeFile('.local/access.json', JSON.stringify(credentials, null, 2));
}
