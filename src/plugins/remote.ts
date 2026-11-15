import { randomUUID } from 'node:crypto';
import { FrameworkError, fail } from '../errors.js';
export interface RpcPeer {
    call(method: string, params: unknown, timeout?: number): Promise<any>;
    close(): Promise<void>;
}
export interface Connection {
    url: string;
    token?: string;
}
export class RemotePeer implements RpcPeer {
    constructor(private connection: Connection) {
        const url = new URL(connection.url);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
            fail('INVALID_INPUT', 'Remote connections require HTTPS except loopback');
        if (url.username || url.password || url.search || url.hash)
            fail('INVALID_INPUT', 'Remote URL must not contain credentials or query data');
    }
    async call(method: string, params: unknown, timeout = 15000) {
        const id = randomUUID();
        let rpc: any;
        try {
            const response = await fetch(this.connection.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout), headers: { 'content-type': 'application/json', ...(this.connection.token ? { authorization: 'Bearer ' + this.connection.token } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
            if (!response.ok)
                fail('UNAVAILABLE', 'Remote peer returned HTTP ' + response.status);
            const chunks: Uint8Array[] = [];
            let size = 0;
            for await (const chunk of response.body ?? []) {
                size += chunk.length;
                if (size > 2000000)
                    fail('INVALID_OUTPUT', 'Remote response exceeded limit');
                chunks.push(chunk);
            }
            rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (rpc.jsonrpc !== '2.0' || rpc.id !== id)
                fail('INVALID_OUTPUT', 'Remote RPC correlation failed');
            if (Object.hasOwn(rpc, 'result') === Object.hasOwn(rpc, 'error'))
                fail('INVALID_OUTPUT', 'Remote RPC requires exactly one result or error');
        }
        catch (error) {
            if (['tool.invoke', 'run.start', 'run.status', 'run.result', 'run.cancel'].includes(method))
                throw new FrameworkError('RESULT_UNKNOWN', 'Remote execution receipt is unavailable; reconcile before retry', { method, requestId: id, causeCode: (error as any).code ?? 'TRANSPORT_ERROR' });
            throw error instanceof FrameworkError ? error : new FrameworkError('UNAVAILABLE', 'Remote peer communication failed');
        }
        if (rpc.error)
            throw new FrameworkError(rpc.error.data?.code ?? 'REMOTE_ERROR', 'Remote peer rejected ' + method);
        return rpc.result;
    }
    async close() { await this.call('plugin.shutdown', {}, 1000).catch(() => { }); }
}
