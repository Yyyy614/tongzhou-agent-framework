import { listenHttp } from './helpers/http-server.js';
import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { RemoteAgentAdapter } from '../src/remote-runtime.js';
test('a refused remote cancellation does not claim that external execution stopped', async () => {
    const server = Fastify();
    let started = false, ended = false, finish = false;
    server.post('/rpc', async (request) => {
        const rpc = request.body as any;
        let result: any;
        if (rpc.method === 'run.start') {
            started = true;
            result = { runId: 'refused', state: 'running' };
        }
        else if (rpc.method === 'run.cancel')
            result = { accepted: false };
        else
            result = { state: finish ? 'cancelled' : 'running' };
        return { jsonrpc: '2.0', id: rpc.id, result };
    });
    await listenHttp(server);
    const adapter = new RemoteAgentAdapter({ url: server.listeningOrigin + '/rpc' });
    const observed = adapter.run('wait', { companyId: 'one', principalId: 'alice', agentId: 'worker', runId: 'host-run', pluginId: '@example/conformance', pluginVersion: '0.1.0', gateway: { modelURL: 'http://127.0.0.1/model', mcpURL: 'http://127.0.0.1/mcp', token: 'fixture' } }).catch(e => e).finally(() => { ended = true; });
    try {
        await expect.poll(() => started, { interval: 20 }).toBe(true);
        // The server can have started before the client has received its handle.
        // A pre-handle cancellation is pending; observe the actual refusal.
        await expect.poll(() => adapter.cancel(), { interval: 20 }).toMatchObject({ accepted: false });
        await new Promise(r => setTimeout(r, 300));
        expect(ended).toBe(false);
    }
    finally {
        finish = true;
        await observed;
        await server.close();
    }
});
