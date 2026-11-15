import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { HarnessRuntime } from '../src/runtime.js';
import { createHash } from 'node:crypto';

test('an invited employee sets a password and signs in on another computer with the same private Agent', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/accounts-')) });
    const app = await createServer(host);
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'admin', companyId: 'one', role: 'admin', permissions: [] });
        await host.putActor({ id: 'staff', companyId: 'one', role: 'employee', permissions: ['memory.self.read', 'memory.self.propose_write'] });
        await host.putAgent({ id: 'staff-agent', ownerId: 'staff', companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [], servicePermissions: ['memory.self.read', 'memory.self.propose_write'], preset: { id: 'company-worker', version: '0.1.0' } });
        const headers = { authorization: 'Bearer ' + await host.issueAccessToken('admin') };
        const invitation = (await app.inject({ method: 'POST', url: '/v1/admin/employees/staff/invitations', headers, payload: {} })).json();
        const password = 'Conformance-only-password-2026!';
        const registered = await app.inject({ method: 'POST', url: '/v1/employee/register', payload: { code: invitation.code, password, deviceName: 'First PC' } });
        expect(registered.statusCode).toBe(201);
        const first = registered.json();
        const firstHeaders = { authorization: 'Bearer ' + first.accessToken };
        expect((await app.inject({ method: 'PUT', url: '/v1/agents/staff-agent/memory/INDEX', headers: firstHeaders, payload: { markdown: '# Same employee across computers', expectedVersion: 0, sourceRefs: ['account-test'] } })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/v1/employee/login', payload: { username: 'staff', password: 'wrong-password', deviceName: 'Second PC' } })).statusCode).toBe(401);
        const loggedIn = await app.inject({ method: 'POST', url: '/v1/employee/login', payload: { username: 'staff', password, deviceName: 'Second PC' } });
        expect(loggedIn.statusCode).toBe(201);
        const second = loggedIn.json();
        expect(second.deviceId).not.toBe(first.deviceId);
        expect(second.accessToken).not.toBe(first.accessToken);
        const secondHeaders = { authorization: 'Bearer ' + second.accessToken };
        const boot = (await app.inject({ url: '/v1/employee/bootstrap', headers: secondHeaders })).json();
        expect(boot.employee.id).toBe('staff');
        expect(boot.agents.map((a: any) => a.id)).toEqual(['staff-agent']);
        expect((await app.inject({ url: '/v1/agents/staff-agent/memory/INDEX', headers: secondHeaders })).json().markdown).toBe('# Same employee across computers');
        expect(JSON.stringify((await app.inject({ url: '/v1/admin/employees', headers })).json())).not.toContain(password);
        expect(JSON.stringify((await host.db.pool.query('SELECT data FROM audit')).rows)).not.toContain(password);
        // A new administrator-issued invitation resets the password and ends
        // both old devices; an employee cannot reset it with just a username.
        const reset = (await app.inject({ method: 'POST', url: '/v1/admin/employees/staff/invitations', headers, payload: {} })).json();
        const changed = await app.inject({ method: 'POST', url: '/v1/employee/register', payload: { code: reset.code, password: password + '-changed', deviceName: 'Recovery PC' } });
        expect(changed.statusCode).toBe(201);
        expect((await app.inject({ url: '/v1/employee/bootstrap', headers: firstHeaders })).statusCode).toBe(401);
        expect((await app.inject({ url: '/v1/employee/bootstrap', headers: secondHeaders })).statusCode).toBe(401);
        expect((await app.inject({ method: 'POST', url: '/v1/employee/login', payload: { username: 'staff', password, deviceName: 'Old password' } })).statusCode).toBe(401);
        expect((await app.inject({ method: 'POST', url: '/v1/employee/login', payload: { username: 'staff', password: password + '-changed', deviceName: 'New password' } })).statusCode).toBe(201);
    } finally { await app.close(); await host.close(); }
});

test('unknown account login attempts are throttled persistently, without an account-enumeration response', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/login-limits-')) });
    let app = await createServer(host);
    const login = (username: string) => app.inject({ method: 'POST', url: '/v1/employee/login', payload: { username, password: 'wrong-password', deviceName: 'Conformance PC' } });
    try {
        const first = await login('unknown');
        expect(first.statusCode).toBe(401);
        await host.putActor({ id: 'disabled', companyId: 'one', role: 'employee', permissions: [], active: false });
        const disabled = await login('disabled');
        expect(disabled.statusCode).toBe(401);
        expect(disabled.json()).toEqual(first.json());
        for (let i = 1; i < 10; i++) expect((await login('unknown')).statusCode).toBe(401);
        expect((await login('unknown')).statusCode).toBe(429);
        await app.close();
        app = await createServer(host);
        expect((await login('unknown')).statusCode).toBe(429);
        expect((await app.inject({ method: 'POST', url: '/v1/employee/register', payload: { code: 'not-an-invitation-but-long-enough-code', password: 'short', deviceName: 'PC' } })).statusCode).toBe(400);
    } finally { await app.close(); await host.close(); }
});

test('password reset frees idle leases without deleting a lease that became active during credential checks', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/account-lease-reset-')) });
    const app = await createServer(host);
    const runtime = new HarnessRuntime(app, host, { apiKey: 'unused-fixture', upstreamURL: 'http://127.0.0.1:1', publicOrigin: 'https://agents.example.test' });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'admin', companyId: 'one', role: 'admin', permissions: [] });
        await host.putActor({ id: 'staff', companyId: 'one', role: 'employee', permissions: ['memory.self.read', 'memory.self.propose_write'] });
        await host.putAgent({ id: 'worker', ownerId: 'staff', companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [], servicePermissions: ['memory.self.read', 'memory.self.propose_write'], preset: { id: 'company-worker', version: '0.1.0' } });
        await host.writeMemory({ principalId: 'staff', agentId: 'worker', noteId: 'INDEX', markdown: '# My index', expectedVersion: 0, sourceRefs: [] });
        const admin = { authorization: 'Bearer ' + await host.issueAccessToken('admin') };
        const register = async (password: string) => {
            const invite = (await app.inject({ method: 'POST', url: '/v1/admin/employees/staff/invitations', headers: admin, payload: {} })).json();
            const result = await app.inject({ method: 'POST', url: '/v1/employee/register', payload: { code: invite.code, password, deviceName: 'PC' } });
            expect(result.statusCode).toBe(201);
            return { authorization: 'Bearer ' + result.json().accessToken };
        };
        const old = await register('Conformance-old-password!');
        const connect = (headers: { authorization: string }) => app.inject({ method: 'POST', url: '/v1/harness/clients', headers, payload: { agentId: 'worker' } });
        const leases: any[] = [];
        for (let i=0; i<5; i++) { const lease = await connect(old); expect(lease.statusCode).toBe(201); leases.push(lease.json()); }
        const originalQuery = host.db.pool.query.bind(host.db.pool);
        const oldHash = createHash('sha256').update(old.authorization.slice(7)).digest('hex');
        let entered!: () => void, resume!: () => void, paused = false;
        const checking = new Promise<void>(r => entered = r), gate = new Promise<void>(r => resume = r);
        host.db.pool.query = (async (sql: any, values: any) => {
            if (!paused && typeof sql === 'string' && sql.startsWith('SELECT 1 FROM access_tokens') && values?.[0] === oldHash) { paused = true; entered(); await gate; }
            return (originalQuery as any)(sql, values);
        }) as any;
        const pending = Promise.resolve(connect(old));
        await checking;
        const started = await app.inject({ method: 'POST', url: '/internal/client/' + leases[0].id + '/turn/start', headers: { authorization: 'Bearer ' + leases[0].token }, payload: { sessionId: 'inflight-session', turnId: 'inflight-turn' } });
        expect(started.statusCode).toBe(200);
        const fresh = await register('Conformance-new-password!');
        resume();
        await pending;
        host.db.pool.query = originalQuery;
        expect((await app.inject({ url: '/v1/harness/clients/' + leases[0].id, headers: fresh })).statusCode).toBe(200);
        expect((await connect(old)).statusCode).toBe(401);
        expect((await connect(fresh)).statusCode).toBe(201);
    } finally { await runtime.close(); await app.close(); await host.close(); }
});
