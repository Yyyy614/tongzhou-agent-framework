import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { RemotePeer } from '../src/plugins/remote.js';
import { RemoteAgentAdapter } from '../src/remote-runtime.js';
test('lost remote execution receipts are explicitly unknown, not ordinary failures', async () => {
    const remote = Fastify();
    let effects = 0;
    remote.post('/rpc', async (request, reply) => { effects++; return reply.code(503).send({ error: 'response lost after commit' }); });
    await remote.listen({ host: '127.0.0.1', port: 0 });
    const peer = new RemotePeer({ url: remote.listeningOrigin + '/rpc' });
    try {
        await expect(peer.call('tool.invoke', { input: {}, idempotencyKey: 'one' })).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
        expect(effects).toBe(1);
    }
    finally {
        await remote.close();
    }
});
test('a missing remote run handle after acceptance requires reconciliation', async () => {
    const remote = Fastify();
    let accepted = 0;
    remote.post('/rpc', async (request) => { accepted++; const rpc = request.body as any; return { jsonrpc: '2.0', id: rpc.id, result: {} }; });
    await remote.listen({ host: '127.0.0.1', port: 0 });
    try {
        const adapter = new RemoteAgentAdapter({ url: remote.listeningOrigin + '/rpc' });
        await expect(adapter.run('do work', { companyId: 'one', principalId: 'alice', agentId: 'worker', runId: 'host-run', pluginId: '@example/conformance', pluginVersion: '0.1.0', gateway: { modelURL: 'http://127.0.0.1/model', mcpURL: 'http://127.0.0.1/mcp', token: 'fixture' } })).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
        expect(accepted).toBe(1);
    }
    finally {
        await remote.close();
    }
});
