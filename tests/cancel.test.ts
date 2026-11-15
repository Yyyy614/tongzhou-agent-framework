import { listenHttp } from './helpers/http-server.js';
import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { HarnessRuntime } from '../src/runtime.js';
test('cancellation reaches the remote executor and interrupted runs require reconciliation', async () => {
    const remote = Fastify();
    let cancelled = false;
    let started = false;
    remote.post('/rpc', async (request) => {
        const rpc = request.body as any;
        let result: any;
        if (rpc.method === 'run.start') {
            started = true;
            result = { runId: 'cancel-target', state: 'running' };
        }
        else if (rpc.method === 'run.cancel') {
            cancelled = true;
            result = { accepted: true };
        }
        else
            result = { state: cancelled ? 'cancelled' : 'running' };
        return { jsonrpc: '2.0', id: rpc.id, result };
    });
    await listenHttp(remote);
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/cancel-')), connections: { 'connection:remote': { url: remote.listeningOrigin + '/rpc' } } });
    const app = await createServer(host);
    const runtime = new HarnessRuntime(app, host, { apiKey: '', upstreamURL: 'https://api.deepseek.com/anthropic' });
    await listenHttp(app);
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'alice', companyId: 'example', role: 'employee', permissions: [] });
        await host.putAgent({ id: 'worker', ownerId: 'alice', companyId: 'example', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [], runtime: 'remote', connectionRef: 'connection:remote' });
        const running = runtime.run({ principalId: 'alice', agentId: 'worker', prompt: 'wait', idempotencyKey: 'one' });
        const observed = running.catch(e => e);
        await expect.poll(async () => (await host.db.pool.query("SELECT id FROM runs WHERE state='running'")).rows.length, { interval: 20 }).toBe(1);
        const id = (await host.db.pool.query("SELECT id FROM runs WHERE state='running'")).rows[0].id;
        await expect.poll(() => started, { interval: 20 }).toBe(true);
        await runtime.cancel(id, 'alice');
        expect((await observed).code).toBe('CANCELLED');
        expect(cancelled).toBe(true);
        expect((await runtime.get(id, 'alice')).state).toBe('cancelled');
        await host.db.pool.query("UPDATE runs SET state='running' WHERE id=$1", [id]);
        await runtime.recoverInterrupted();
        expect((await runtime.get(id, 'alice')).state).toBe('reconciliation_required');
    }
    finally {
        cancelled = true;
        await runtime.close();
        await app.close();
        await host.close();
        await remote.close();
    }
});
