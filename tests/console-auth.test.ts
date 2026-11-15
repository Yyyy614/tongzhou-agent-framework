import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { ConsoleSessions } from '../src/console-auth.js';
test('console entry codes are single use, cookies are HttpOnly, and cookie writes require same origin', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/console-auth-')) });
    const app = await createServer(host);
    try {
        await host.putActor({ id: 'admin', companyId: 'example', role: 'admin', permissions: [] });
        expect((await app.inject({ url: '/console/me' })).statusCode).toBe(401);
        const code = await new ConsoleSessions(host).issueCode('admin');
        const response = await app.inject({ method: 'POST', url: '/console/login', headers: { origin: 'http://localhost' }, payload: { code } });
        expect(response.statusCode).toBe(200);
        const setCookie = String(response.headers['set-cookie']);
        expect(setCookie).toContain('HttpOnly');
        expect(setCookie).toContain('SameSite=Strict');
        const cookie = setCookie.split(';')[0]!;
        expect((await app.inject({ url: '/console/me', headers: { cookie } })).json()).toMatchObject({ id: 'admin', role: 'admin' });
        expect((await app.inject({ method: 'POST', url: '/console/login', headers: { origin: 'http://localhost' }, payload: { code } })).statusCode).toBe(401);
        expect((await app.inject({method:'POST',url:'/v1/admin/employees',headers:{cookie,authorization:'Basic unsupported',origin:'https://foreign.example'},payload:{id:'csrf-check',displayName:'CSRF test',role:'employee',permissions:[]}})).statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: '/console/logout', headers: { cookie, origin: 'https://foreign.example' } })).statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: '/console/logout', headers: { cookie, origin: 'http://localhost' } })).statusCode).toBe(200);
        expect((await app.inject({ url: '/console/me', headers: { cookie } })).statusCode).toBe(401);
    }
    finally {
        await app.close();
        await host.close();
    }
});

test('HTTPS console cookies trust only the explicitly configured proxy address', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/console-proxy-')) });
    const app = await createServer(host, { trustedProxyIP: '172.18.0.4' });
    try {
        await host.putActor({ id: 'admin', companyId: 'example', role: 'admin', permissions: [] });
        const code = await new ConsoleSessions(host).issueCode('admin');
        const headers = { host: 'sales.example.test:8443', origin: 'https://sales.example.test:8443', 'x-forwarded-proto': 'https' };
        const untrusted = await app.inject({ method: 'POST', url: '/console/login', remoteAddress: '172.18.0.99', headers, payload: { code } });
        expect(untrusted.statusCode).toBe(403);
        const proxied = await app.inject({ method: 'POST', url: '/console/login', remoteAddress: '172.18.0.4', headers, payload: { code } });
        expect(proxied.statusCode).toBe(200);
        expect(proxied.headers['set-cookie']).toContain('; Secure');
    } finally { await app.close(); await host.close(); }
});
