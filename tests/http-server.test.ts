import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { createServer } from 'node:net';
import { listenHttp } from './helpers/http-server.js';

test('an HTTP fixture uses a Fetch-compatible loopback port and reaches its real handler once', async () => {
    const app = Fastify(); let effects = 0;
    app.post('/rpc', async (_request, reply) => { effects++; return reply.code(503).send({ error: 'receipt lost after commit' }); });
    try {
        const origin = await listenHttp(app), url = new URL(origin);
        expect(url.hostname).toBe('127.0.0.1'); expect(Number(url.port)).toBeGreaterThanOrEqual(49152);
        const response = await fetch(origin + '/rpc', { method: 'POST' });
        expect(response.status).toBe(503); await response.json(); expect(effects).toBe(1);
    } finally { await app.close(); }
});

test('a busy HTTP test port falls back before serving requests without disturbing its owner', async () => {
    const owner = Fastify(), candidate = Fastify();
    owner.get('/', async () => 'owner'); candidate.get('/', async () => 'candidate');
    try {
        const first = await listenHttp(owner), second = await listenHttp(candidate, Number(new URL(first).port));
        expect(second).not.toBe(first);
        expect(await (await fetch(first)).text()).toBe('owner');
        expect(await (await fetch(second)).text()).toBe('candidate');
    } finally { await candidate.close(); await owner.close(); }
});

test('unsafe explicit ports and application startup errors are not hidden by bind retries', async () => {
    const unsafe = Fastify(), broken = Fastify();
    const permissionError = Object.assign(Error('fixture startup failed'), { code: 'EACCES', syscall: 'open' });
    broken.addHook('onReady', async () => { throw permissionError; });
    try {
        await expect(listenHttp(unsafe, 6667)).rejects.toThrow('49152..65535');
        expect(unsafe.server.listening).toBe(false);
        await expect(listenHttp(broken)).rejects.toBe(permissionError);
        expect(broken.server.listening).toBe(false);
    } finally { await unsafe.close(); await broken.close(); }
});

test('an application startup listener conflict is propagated before the HTTP binding retry phase', async () => {
    const owner = Fastify(), app = Fastify(), nested = createServer();
    let startupError: Error | undefined;
    owner.get('/', async () => 'owner');
    app.addHook('onReady', async () => {
        await new Promise<void>((resolve, reject) => {
            nested.once('error', error => { startupError = error; reject(error); });
            nested.listen({ host: '127.0.0.1', port: Number(new URL(owner.listeningOrigin).port) }, () => resolve());
        });
    });
    try {
        const origin = await listenHttp(owner);
        let received: unknown;
        try { await listenHttp(app); } catch (error) { received = error; }
        expect(startupError).toMatchObject({ code: 'EADDRINUSE', syscall: 'listen' });
        expect(received).toBe(startupError); expect(app.server.listening).toBe(false);
        expect(await (await fetch(origin)).text()).toBe('owner');
    } finally {
        if (nested.listening) await new Promise<void>(resolve => nested.close(() => resolve()));
        await app.close(); await owner.close();
    }
});
