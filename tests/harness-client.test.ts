import { listenHttp } from './helpers/http-server.js';
import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { HarnessRuntime } from '../src/runtime.js';
import { prepareHarnessProfile } from '../src/harness-profile.js';

test('an external Harness client uses an employee-scoped connection, company tools and measured usage without the provider key', async () => {
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/harness-client-'));
    const host = await createFramework({ root });
    const app = await createServer(host);
    const upstream = Fastify();
    let calls = 0;
    upstream.post('/v1/messages', async (request, reply) => {
        calls++; const body = request.body as any;
        const tool = body.tools.find((t: any) => t.name.includes('normalize'))?.name;
        expect(body.tools.every((t: any) => t.name.startsWith('mcp__company__'))).toBe(true);
        const done = JSON.stringify(body.messages).includes('tool_result');
        const events: any[] = [['message_start', { type: 'message_start', message: { id: 'native-' + calls, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 80, output_tokens: 1 } } }]];
        if (done) events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'native company client' } }]);
        else events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'native-tool-1', name: tool, input: {} } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ text: '  native   company   client ' }) } }]);
        events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: done ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } }], ['message_stop', { type: 'message_stop' }]);
        reply.header('content-type', 'text/event-stream').send(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
    await listenHttp(upstream);
    const runtime = new HarnessRuntime(app, host, { apiKey: 'private-upstream-fixture', upstreamURL: upstream.listeningOrigin });
    await listenHttp(app);
    let harness: DeepSeekHarness | undefined;
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'alice', companyId: 'one', role: 'employee', permissions: ['tool.invoke:@example/conformance:text.normalize'] });
        await host.putActor({ id: 'bob', companyId: 'one', role: 'employee', permissions: [] });
        await host.putAgent({ id: 'worker', ownerId: 'alice', companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: ['@example/conformance:text.normalize'], preset: { id: 'company-worker', version: '0.1.0' } });
        const headers = { authorization: 'Bearer ' + await host.issueAccessToken('alice') };
        const connected = await app.inject({ method: 'POST', url: '/v1/harness/clients', headers, payload: { agentId: 'worker' } });
        expect(connected.statusCode).toBe(201);
        const lease = connected.json();
        expect(JSON.stringify(lease)).not.toContain('private-upstream-fixture');
        const stranger = { authorization: 'Bearer ' + await host.issueAccessToken('bob') };
        expect((await app.inject({ url: '/v1/harness/clients/' + lease.id, headers: stranger })).statusCode).toBe(403);
        const home = resolve(root, 'external-harness'); await mkdir(home);
        const deployment = await prepareHarnessProfile(home, 'desktop', lease, host.presets.get(lease.preset));
        // Exercise real profile module routing, without a test-only dependency install.
        const disabled = ['terminal-bash', 'terminal-pwsh', 'persistent-bash', 'persistent-pwsh', 'tool-fs', 'tool-working-directory', 'session-log-deepseek', 'plugin-package-inventory-deepseek', 'mcp-resources'];
        const patch = [...disabled.map(id => ({ id, disabled: true })), { id: 'llm-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: lease.modelURL, thinking: 'disabled', reasoningEffort: 'off', defaultContextWindow: 16000 } }, { insert: [{ id: 'company-client-bridge', name: pathToFileURL(resolve(deployment.deployed,'index.mjs')).href, config: {mcpURL:lease.mcpURL,modelURL:lease.modelURL,token:lease.token} }] }];
        const path = resolve(home, 'managed.yml'); await writeFile(path, stringify(patch));
        harness = new DeepSeekHarness({ profile: 'sdk-minimal', dshHome: home, cwd: home, processCwd: home, patches: [path], env: { ...process.env, DEEPSEEK_API_KEY: lease.token, DEEPSEEK_BASE_URL: lease.modelURL, DSH_HOME: home }, provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 1024 });
        const result = await harness.run('Normalize this text using the company tool.');
        expect(result.finalResponse).toContain('native company client');
        expect(calls).toBe(2);
        const status = (await app.inject({ url: '/v1/harness/clients/' + lease.id, headers })).json();
        expect(status.lastRun.state).toBe('succeeded');
        const usage = await runtime.usage({ principalId: 'alice', agentId: 'worker' });
        expect(usage.requests).toBe(2); expect(usage.inputTokens).toBe(160);
        expect((await host.listLogs({ principalId: 'alice', agentId: 'worker' })).some(l => l.type === 'tool.succeeded')).toBe(true);
        await app.inject({ method: 'DELETE', url: '/v1/harness/clients/' + lease.id, headers });
        expect((await app.inject({ method: 'POST', url: new URL(lease.mcpURL).pathname, headers: { authorization: 'Bearer ' + lease.token }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).statusCode).toBe(401);
    } finally { await harness?.close(); await runtime.close(); await app.close(); await upstream.close(); await host.close(); }
}, 60000);
