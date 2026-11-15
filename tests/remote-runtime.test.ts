import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { HarnessRuntime } from '../src/runtime.js';
test('an existing remote agent runs through the task contract without requiring the company model key', async () => {
    const remote = Fastify();
    let context: any;
    remote.post('/rpc', async (request) => {
        const rpc = request.body as any;
        let result: any;
        if (rpc.method === 'run.start') {
            context = rpc.params.context;
            result = { runId: 'remote-1', state: 'running' };
        }
        else if (rpc.method === 'run.status')
            result = { runId: 'remote-1', state: 'succeeded' };
        else if (rpc.method === 'run.result')
            result = { output: 'remote completed', evidenceRefs: ['remote:evidence-1'], usage: { inputTokens: 10, outputTokens: 5 } };
        else
            result = { accepted: true };
        return { jsonrpc: '2.0', id: rpc.id, result };
    });
    await remote.listen({ host: '127.0.0.1', port: 0 });
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/remote-run-')), connections: { 'connection:existing-agent': { url: remote.listeningOrigin + '/rpc' } } });
    const app = await createServer(host);
    const runtime = new HarnessRuntime(app, host, { apiKey: '', upstreamURL: 'https://api.deepseek.com/anthropic' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'alice', companyId: 'example', role: 'employee', permissions: [] });
        await host.putAgent({ id: 'remote-worker', ownerId: 'alice', companyId: 'example', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [], runtime: 'remote', connectionRef: 'connection:existing-agent' });
        const result = await runtime.run({ principalId: 'alice', agentId: 'remote-worker', prompt: 'Do the assigned task', idempotencyKey: 'one' });
        expect(result.state).toBe('succeeded');
        expect(result.output).toBe('remote completed');
        expect(context).toMatchObject({ principalId: 'alice', agentId: 'remote-worker', companyId: 'example' });
        const usage = await runtime.usage({ principalId: 'alice', agentId: 'remote-worker' });
        expect(usage.records[0].measurement).toBe('remote-reported');
        expect(usage.inputTokens).toBe(10);
    }
    finally {
        await runtime.close();
        await app.close();
        await host.close();
        await remote.close();
    }
});
