import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { HarnessRuntime } from '../src/runtime.js';
import { listenHttp } from './helpers/http-server.js';

test('actual provider requests contain only the current turn, authorized pack and host-confirmed tool receipts', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/actual-context-')) });
    const app = await createServer(host), provider = Fastify(); const bodies: any[] = [];
    provider.post('/v1/messages', request => { const body = request.body as any; bodies.push(body); const assessment=String(body.system).includes('event-routing-classifier'); return { id: 'response-' + bodies.length, role: 'assistant', type: 'message', content: [{ type: 'text', text: assessment?JSON.stringify({action:'assign',agentId:'job',reason:'matches bounded role'}):'current turn finished' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 5 } }; });
    await listenHttp(provider);
    const runtime = new HarnessRuntime(app, host, { apiKey: 'context-fixture', upstreamURL: provider.listeningOrigin }); await listenHttp(app);
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'alice', companyId: 'one', role: 'employee', permissions: [] });
        await host.putAgent({ id: 'job', ownerId: 'alice', companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        const headers = { authorization: 'Bearer ' + await host.issueAccessToken('alice') };
        const lease = (await app.inject({ method: 'POST', url: '/v1/harness/clients', headers, payload: { agentId: 'job' } })).json();
        const native = { authorization: 'Bearer ' + lease.token };
        const start = async (turnId: string) => app.inject({ method: 'POST', url: '/internal/client/' + lease.id + '/turn/start', headers: native, payload: { sessionId: 'chat', turnId } });
        expect((await start('1')).statusCode).toBe(200);
        const model = (turn: string, messages: any[]) => app.inject({ method: 'POST', url: '/internal/client/' + lease.id + '/model/v1/messages', headers: { 'x-api-key': lease.token, 'x-company-turn-id': turn, 'x-deepseek-harness-session-id': 'chat' }, payload: { model: 'deepseek-flash', max_tokens: 256, system: 'OLD-SYSTEM-SECRET', messages, tools: [] } });
        expect((await model('1', [{ role: 'user', content: 'OTHER-WORK-SECRET' }, { role: 'assistant', content: 'OTHER-WORK-OUTPUT' }, { role: 'user', content: 'CURRENT-WORK-INPUT' }])).statusCode).toBe(200);
        expect(JSON.stringify(bodies[0])).not.toMatch(/OTHER-WORK|OLD-SYSTEM/);
        expect(JSON.stringify(bodies[0])).toContain('CURRENT-WORK-INPUT');
        expect(JSON.stringify(bodies[0])).toContain('ContextPack');
        expect((await start('2')).statusCode).toBe(200);
        expect((await model('2', [{ role: 'user', content: 'CURRENT-WORK-INPUT' }, { role: 'assistant', content: 'current turn finished' }, { role: 'user', content: 'SECOND-WORK-INPUT' }])).statusCode).toBe(200);
        expect(JSON.stringify(bodies[1])).not.toContain('CURRENT-WORK-INPUT');
        const usage = await host.db.pool.query('SELECT data FROM usage ORDER BY created_at');
        expect(usage.rows[0].data.contextManifest).toMatchObject({ historyPolicy: 'host-owned-turn', contextPackId: expect.any(String) });
        const tasks = (await host.db.pool.query('SELECT id FROM tasks ORDER BY created_at')).rows;
        expect(await host.results.view('alice', tasks[0].id)).toMatchObject({ processAvailable: true });
        const assessed=await runtime.assessEvent({eventId:'00000000-0000-4000-8000-000000000001',sourceId:'00000000-0000-4000-8000-000000000002',principalId:'alice',eventType:'request',summary:'bounded assignment',candidates:[{agentId:'job',description:'generic role'},{agentId:'another',description:'different role'}]});
        expect(assessed).toMatchObject({action:'assign',agentId:'job'});
        expect(bodies[2].tools).toEqual([]); expect(JSON.stringify(bodies[2])).not.toMatch(/CURRENT-WORK|SECOND-WORK/);
        expect((await host.db.pool.query("SELECT data FROM usage WHERE data->>'purpose'='event-routing'")).rows[0].data.inputTokens).toBe(20);
    } finally { await runtime.close(); await app.close(); await provider.close(); await host.close(); }
});
