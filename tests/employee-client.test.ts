import { test, expect } from 'vitest';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify from 'fastify';

test('the actual employee transport releases a connection with a bodyless DELETE', async () => {
    const { companyFetch } = await import('../client/company-fetch.mjs');
    const backend = Fastify();
    let released = 0;
    backend.delete('/v1/harness/clients/connection', async () => { released++; return { closed: true }; });
    await backend.listen({ host: '127.0.0.1', port: 0 });
    try {
        const response = await companyFetch(backend.listeningOrigin, '/v1/harness/clients/connection', { method: 'DELETE', token: 'fixture-employee' });
        expect(response.status).toBe(200);
        expect((await response.json()).closed).toBe(true);
        expect(released).toBe(1);
    } finally { await backend.close(); }
});

test('an employee signs in on a fresh computer without saving their password or sharing a device identity', async () => {
    const { createEmployeeClient } = await import('../client/employee-app.mjs');
    await mkdir('.test-data', { recursive: true });
    const dataDir = await mkdtemp(resolve('.test-data/employee-account-client-'));
    const backend = Fastify();
    backend.post('/v1/employee/login', async request => {
        expect(request.body).toEqual({ username: 'staff', password: 'Conformance-only-password!', deviceName: 'Second PC' });
        return { accessToken: 'account-device-fixture', deviceId: 'second-device', employee: { id: 'staff', displayName: '员工' } };
    });
    backend.get('/v1/employee/bootstrap', async () => ({ employee: { id: 'staff', displayName: '员工' }, agents: [] }));
    await backend.listen({ host: '127.0.0.1', port: 0 });
    const protection = { encrypt: async v => Buffer.from(v).toString('base64'), decrypt: async v => Buffer.from(v, 'base64').toString() };
    let app;
    try {
        app = await createEmployeeClient({ dataDir, serverURL: backend.listeningOrigin, protection });
        const response = await fetch(app.origin + '/api/login', { method: 'POST', headers: { 'x-client-session': app.session, origin: app.origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'staff', password: 'Conformance-only-password!', deviceName: 'Second PC' }) });
        expect(response.status).toBe(201);
        expect((await response.json()).employee.id).toBe('staff');
        expect(await readFile(resolve(dataDir, 'identity.json'), 'utf8')).not.toContain('Conformance-only-password!');
    } finally { await app?.close(); await backend.close(); }
});

test('a separately installed employee client activates once and reopens without developer credentials', async () => {
    const { createEmployeeClient } = await import('../client/employee-app.mjs');
    await mkdir('.test-data', { recursive: true });
    const dataDir = await mkdtemp(resolve('.test-data/employee-client-'));
    const backend = Fastify();
    backend.post('/v1/employee/activate', async request => {
        expect(request.body).toEqual({ code: 'single-use-employee-fixture', deviceName: 'Employee PC' });
        return { accessToken: 'employee-identity-fixture', deviceId: 'device-one', expiresAt: '2099-01-01', employee: { id: 'staff', displayName: '员工' } };
    });
    backend.get('/v1/employee/bootstrap', async request => {
        expect(request.headers.authorization).toBe('Bearer employee-identity-fixture');
        return { employee: { id: 'staff', displayName: '员工' }, agents: [{ id: 'staff-agent', displayName: '岗位助手', presetName: '岗位员工' }] };
    });
    backend.post('/v1/employee/logout', async () => ({ revoked: true }));
    await backend.listen({ host: '127.0.0.1', port: 0 });
    // Storage boundary fixture; real Windows DPAPI is separately exercised live.
    const protection = { encrypt: async token => 'protected:' + Buffer.from(token).toString('base64'), decrypt: async token => Buffer.from(token.slice(10), 'base64').toString() };
    let app;
    try {
        app = await createEmployeeClient({ dataDir, serverURL: backend.listeningOrigin, protection });
        await expect(createEmployeeClient({ dataDir, serverURL: backend.listeningOrigin, protection })).rejects.toThrow();
        const headers = { 'x-client-session': app.session, origin: app.origin, 'content-type': 'application/json' };
        expect((await fetch(app.origin + '/api/state')).status).toBe(401);
        expect((await fetch(app.origin + '/api/activate', { method: 'POST', headers: { ...headers, origin: 'http://untrusted.invalid' }, body: '{}' })).status).toBe(403);
        const response = await fetch(app.origin + '/api/activate', { method: 'POST', headers, body: JSON.stringify({ code: 'single-use-employee-fixture', deviceName: 'Employee PC' }) });
        expect(response.status).toBe(201);
        expect(JSON.stringify(await response.json())).not.toContain('employee-identity-fixture');
        expect(await readFile(resolve(dataDir, 'identity.json'), 'utf8')).not.toContain('employee-identity-fixture');
        await app.close();
        app = await createEmployeeClient({ dataDir, serverURL: backend.listeningOrigin, protection });
        const state = await fetch(app.origin + '/api/state', { headers: { 'x-client-session': app.session } }).then(r => r.json());
        expect(state.employee.id).toBe('staff'); expect(state.agents[0].id).toBe('staff-agent');
        expect((await fetch(app.origin + '/api/logout', { method: 'POST', headers: { 'x-client-session': app.session, origin: app.origin }, body: '{}' })).status).toBe(200);
        const signedOut = await fetch(app.origin + '/api/state', { headers: { 'x-client-session': app.session } }).then(r => r.json());
        expect(signedOut.authenticated).toBe(false);
    } finally { await app?.close(); await backend.close(); }
});

test('a second client window cannot activate while sign-out is still completing', async () => {
    const { createEmployeeClient } = await import('../client/employee-app.mjs');
    await mkdir('.test-data', { recursive: true });
    const dataDir = await mkdtemp(resolve('.test-data/employee-signout-'));
    const backend = Fastify();
    let activations = 0, revoked = false;
    let entered!: () => void, release!: () => void;
    const signingOut = new Promise<void>(r => entered = r), paused = new Promise<void>(r => release = r);
    backend.post('/v1/employee/activate', async () => ({ accessToken: 'identity-' + (++activations), deviceId: 'device-' + activations, employee: { id: 'staff' } }));
    backend.get('/v1/employee/bootstrap', async (request, reply) => {
        if (revoked && request.headers.authorization === 'Bearer identity-1') return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
        return { employee: { id: 'staff' }, agents: [] };
    });
    backend.post('/v1/employee/logout', async () => { revoked = true; entered(); await paused; return { revoked: true }; });
    await backend.listen({ host: '127.0.0.1', port: 0 });
    const protection = { encrypt: async v => Buffer.from(v).toString('base64'), decrypt: async v => Buffer.from(v, 'base64').toString() };
    let app, logout;
    try {
        app = await createEmployeeClient({ dataDir, serverURL: backend.listeningOrigin, protection });
        const headers = { 'x-client-session': app.session, origin: app.origin, 'content-type': 'application/json' };
        const activate = () => fetch(app.origin + '/api/activate', { method: 'POST', headers, body: JSON.stringify({ code: 'invitation-fixture', deviceName: 'PC' }) });
        expect((await activate()).status).toBe(201);
        logout = fetch(app.origin + '/api/logout', { method: 'POST', headers, body: '{}' });
        await signingOut;
        expect((await activate()).status).toBe(409);
        release();
        expect((await logout).status).toBe(200);
        expect(activations).toBe(1);
        expect((await fetch(app.origin + '/api/state', { headers })).status).toBe(200);
    } finally { release(); await logout?.catch(() => {}); await app?.close(); await backend.close(); }
});
