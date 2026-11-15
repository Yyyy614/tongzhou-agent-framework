import { listenHttp } from './helpers/http-server.js';
import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { HarnessRuntime } from '../src/runtime.js';
import { TaskQueue } from '../src/tasks.js';
test('a real Harness coordinator delegates through MCP to a separately owned remote worker', async () => {
    const upstream = Fastify();
    let modelCalls = 0;
    upstream.post('/v1/messages', async (request, reply) => {
        const body = request.body as any;
        const final = ++modelCalls > 1;
        const tool = body.tools.find((t: any) => t.name.endsWith('__task_delegate'))?.name;
        const events: any[] = [['message_start', { type: 'message_start', message: { id: 'coord-' + modelCalls, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } }]];
        if (!final)
            events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'delegate-1', name: tool, input: {} } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ agentId: 'child', prompt: 'Complete the independent task' }) } }]);
        else
            events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Delegated with a task reference.' } }]);
        events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: final ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }], ['message_stop', { type: 'message_stop' }]);
        return reply.header('content-type', 'text/event-stream').send(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
    await listenHttp(upstream);
    const remote = Fastify();
    let executedBy = '';
    remote.post('/rpc', async (request) => {
        const rpc = request.body as any;
        let result: any;
        if (rpc.method === 'run.start') {
            executedBy = rpc.params.context.principalId;
            result = { runId: 'child-run', state: 'succeeded' };
        }
        else
            result = { output: 'Child summary only', usage: { inputTokens: 10, outputTokens: 3 } };
        return { jsonrpc: '2.0', id: rpc.id, result };
    });
    await listenHttp(remote);
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/harness-delegate-')), connections: { 'connection:child': { url: remote.listeningOrigin + '/rpc' } } });
    const app = await createServer(host);
    const runtime = new HarnessRuntime(app, host, { apiKey: 'fixture', upstreamURL: upstream.listeningOrigin });
    const queue = new TaskQueue(host, runtime);
    runtime.enableDelegation(queue);
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'alice', companyId: 'example', role: 'employee', permissions: [] });
        await host.putActor({ id: 'coordinator', companyId: 'example', role: 'employee', permissions: ['agent.execute:child', 'agent.read:child'] });
        await host.putAgent({ id: 'child', ownerId: 'alice', companyId: 'example', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [], runtime: 'remote', connectionRef: 'connection:child' });
        await host.putAgent({ id: 'coord', ownerId: 'coordinator', companyId: 'example', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [], delegates: ['child'] });
        await queue.open();
        await listenHttp(app);
        await queue.startWorker();
        const parent = await queue.submit({ principalId: 'coordinator', agentId: 'coord', prompt: 'Delegate one task to child.', idempotencyKey: 'one' });
        await expect.poll(async () => (await queue.get(parent.id, 'coordinator')).state, { timeout: 15000, interval: 100 }).toBe('succeeded');
        await expect.poll(async () => (await queue.summaries('child', 'coordinator'))[0]?.state, { timeout: 10000, interval: 100 }).toBe('succeeded');
        expect(executedBy).toBe('alice');
        expect(modelCalls).toBe(2);
        const child = (await queue.summaries('child', 'coordinator'))[0];
        expect(child.summary).toBe('执行已结束，等待人工核对');
        expect(JSON.stringify(child)).not.toContain('Child summary only');
        const usage = await runtime.usage({ principalId: 'alice', agentId: 'child' });
        expect(usage.records[0].initiatingPrincipalId).toBe('coordinator');
        expect((await host.listLogs({ principalId: 'coordinator', agentId: 'coord' })).some(l => l.type === 'runtime.tool_succeeded' && l.data.toolName === 'task_delegate')).toBe(true);
    }
    finally {
        await runtime.close();
        await queue.close();
        await app.close();
        await host.close();
        await remote.close();
        await upstream.close();
    }
}, 30000);
