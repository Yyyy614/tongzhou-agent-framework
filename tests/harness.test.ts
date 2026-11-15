import { listenHttp } from './helpers/http-server.js';
import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { HarnessRuntime } from '../src/runtime.js';
test('real Harness calls a mounted tool through scoped MCP and records provider usage per employee', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/harness-')) });
    const app = await createServer(host);
    const upstream = Fastify();
    let calls = 0;
    let seenTools: string[] = [];
    let seenSystem = '';
    upstream.post('/v1/messages', async (request, reply) => {
        calls++;
        const body = request.body as any;
        seenSystem = JSON.stringify(body.system);
        seenTools = body.tools.map((t: any) => t.name);
        const hasResult = JSON.stringify(body.messages).includes('tool_result');
        const tool = seenTools.find(n => n.includes('normalize'))!;
        const events: any[] = [['message_start', { type: 'message_start', message: { id: 'msg-' + calls, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 80, output_tokens: 1 } } }]];
        if (!hasResult)
            events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'fixture-call-1', name: tool, input: {} } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ text: '  hello   framework  ' }) } }]);
        else
            events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello framework' } }]);
        events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: hasResult ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } }], ['message_stop', { type: 'message_stop' }]);
        reply.header('content-type', 'text/event-stream').send(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
    await listenHttp(upstream);
    const runtime = new HarnessRuntime(app, host, { apiKey: 'fixture-provider-secret', upstreamURL: upstream.listeningOrigin, model: 'deepseek-flash' });
    await listenHttp(app);
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'alice', companyId: 'example', role: 'employee', permissions: ['tool.invoke:@example/conformance:text.normalize'] });
        await host.putAgent({ id: 'worker', ownerId: 'alice', companyId: 'example', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: ['@example/conformance:text.normalize'], preset: { id: 'company-worker', version: '0.1.0' }, instructions: 'Use the normalize tool, then answer.' });
        const result = await runtime.run({ principalId: 'alice', agentId: 'worker', prompt: 'Normalize text.', idempotencyKey: 'one' });
        expect(result.state).toBe('succeeded');
        expect(result.output).toContain('hello framework');
        expect(seenSystem).toContain('完成本人负责的工作');
        expect(seenSystem).toContain('Use the normalize tool');
        expect(result.preset).toEqual({ id: 'company-worker', version: '0.1.0' });
        expect(calls).toBe(2);
        expect(seenTools.length).toBeGreaterThan(0);
        expect(seenTools.every(n => n.startsWith('mcp__company__'))).toBe(true);
        const logs = await host.listLogs({ principalId: 'alice', agentId: 'worker' });
        expect(logs.some(l => l.type === 'tool.succeeded')).toBe(true);
        expect(JSON.stringify(logs)).not.toContain('fixture-provider-secret');
        const usage = await runtime.usage({ principalId: 'alice', agentId: 'worker' });
        expect(usage.inputTokens).toBe(160);
        expect(usage.outputTokens).toBe(24);
        expect(usage.requests).toBe(2);
        const replay = await runtime.run({ principalId: 'alice', agentId: 'worker', prompt: 'Normalize text.', idempotencyKey: 'one' });
        expect(replay.id).toBe(result.id);
        expect(calls).toBe(2);
    }
    finally {
        await runtime.close();
        await app.close();
        await upstream.close();
        await host.close();
    }
}, 60000);
