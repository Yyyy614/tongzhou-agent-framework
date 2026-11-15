import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { HarnessRuntime } from '../src/runtime.js';

test('an administrator onboards an employee once, with an independent device identity, agent and memory', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/onboarding-')) });
    const app = await createServer(host);
    const runtime = new HarnessRuntime(app, host, { apiKey: 'unused-fixture', upstreamURL: 'http://127.0.0.1:1', publicOrigin: 'https://agents.example.test' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'admin', companyId: 'one', role: 'admin', permissions: [] });
        await host.putActor({ id: 'other-admin', companyId: 'two', role: 'admin', permissions: [] });
        const admin = { authorization: 'Bearer ' + await host.issueAccessToken('admin') };
        const foreign = { authorization: 'Bearer ' + await host.issueAccessToken('other-admin') };
        for (const id of ['staff', 'peer']) {
            expect((await app.inject({ method: 'POST', url: '/v1/admin/employees', headers: admin, payload: { id, displayName: id, role: 'employee', permissions: ['tool.invoke:@example/conformance:text.normalize', 'memory.self.read', 'memory.self.propose_write', 'report.self.write'] } })).statusCode).toBe(201);
            expect((await app.inject({ method: 'POST', url: '/v1/admin/agents', headers: admin, payload: { id: id + '-agent', ownerId: id, pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: ['@example/conformance:text.normalize'], servicePermissions: ['memory.self.read', 'memory.self.propose_write', 'report.self.write'], preset: { id: 'company-worker', version: '0.1.0' } } })).statusCode).toBe(201);
        }
        const issued = await app.inject({ method: 'POST', url: '/v1/admin/employees/staff/invitations', headers: admin, payload: {} });
        expect(issued.statusCode).toBe(201);
        const invitation = issued.json();
        expect(JSON.stringify((await app.inject({ url: '/v1/admin/employees', headers: admin })).json())).not.toContain(invitation.code);
        expect((await app.inject({ method: 'POST', url: '/v1/admin/employees/staff/invitations', headers: foreign, payload: {} })).statusCode).toBe(403);
        const activation = { code: invitation.code, deviceName: 'Employee laptop' };
        const deliveries = await Promise.all(Array.from({ length: 10 }, () => app.inject({ method: 'POST', url: '/v1/employee/activate', payload: activation })));
        expect(deliveries.filter(r => r.statusCode === 201)).toHaveLength(1);
        expect(deliveries.filter(r => r.statusCode === 401)).toHaveLength(9);
        const device = deliveries.find(r => r.statusCode === 201)!.json();
        const headers = { authorization: 'Bearer ' + device.accessToken };
        const connected = (await app.inject({ method: 'POST', url: '/v1/harness/clients', headers, payload: { agentId: 'staff-agent' } })).json();
        expect(new URL(connected.modelURL).origin).toBe('https://agents.example.test');
        const login = await app.inject({ method: 'POST', url: '/console/login', headers: { origin: app.listeningOrigin, host: new URL(app.listeningOrigin).host }, payload: { accessToken: device.accessToken } });
        expect(login.statusCode).toBe(200);
        const cookie = String(login.headers['set-cookie']).split(';')[0]!;
        expect((await host.authenticate(device.accessToken)).id).toBe('staff');
        const boot = (await app.inject({ url: '/v1/employee/bootstrap', headers })).json();
        expect(boot.employee.id).toBe('staff'); expect(boot.agents.map((a: any) => a.id)).toEqual(['staff-agent']);
        expect((await app.inject({ url: '/v1/admin/employees', headers })).statusCode).toBe(403);
        expect((await app.inject({ url: '/v1/admin/employee-client', headers })).statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: '/v1/admin/employees/peer/invitations', headers, payload: {} })).statusCode).toBe(403);
        expect((await app.inject({ method: 'PUT', url: '/v1/agents/staff-agent/memory/INDEX', headers, payload: { markdown: '# Staff private index', expectedVersion: 0, sourceRefs: ['onboarding'] } })).statusCode).toBe(200);
        expect((await app.inject({ url: '/v1/agents/peer-agent/memory/INDEX', headers })).statusCode).toBe(403);
        const devices = (await app.inject({ url: '/v1/admin/employees/staff/devices', headers: admin })).json();
        expect(devices[0].id).toBe(device.deviceId); expect(JSON.stringify(devices)).not.toContain(device.accessToken);
        const audit = (await host.db.pool.query('SELECT data FROM audit')).rows;
        expect(JSON.stringify(audit)).not.toContain(invitation.code); expect(JSON.stringify(audit)).not.toContain(device.accessToken);
        expect((await app.inject({ method: 'DELETE', url: '/v1/admin/employees/staff/devices/' + device.deviceId, headers: foreign })).statusCode).toBe(403);
        // Exercise the actual console request helper over HTTP, including a
        // bodyless DELETE. Header-only inject calls missed this browser path.
        const { api } = await import('../web/api.js');
        const originalFetch = globalThis.fetch;
        try {
            globalThis.fetch = (path, init) => originalFetch(new URL(String(path), app.listeningOrigin), { ...init, headers: { ...init?.headers, ...admin } });
            expect((await api('/v1/admin/employees/staff/devices/' + device.deviceId, 'DELETE')).revoked).toBe(true);
        } finally { globalThis.fetch = originalFetch; }
        expect((await app.inject({ url: '/v1/employee/bootstrap', headers })).statusCode).toBe(401);
        expect((await app.inject({ method: 'POST', url: new URL(connected.mcpURL).pathname, headers: { authorization: 'Bearer ' + connected.token }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).statusCode).toBe(401);
        expect((await app.inject({ url: '/console/me', headers: { cookie } })).statusCode).toBe(401);
    } finally { await runtime.close(); await app.close(); await host.close(); }
});

test('reissued invitations replace old codes and cannot activate an unassigned or disabled employee', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/invitation-boundaries-')) });
    const app = await createServer(host);
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'admin', companyId: 'one', role: 'admin', permissions: [] });
        await host.putActor({ id: 'staff', companyId: 'one', role: 'employee', permissions: [] });
        const headers = { authorization: 'Bearer ' + await host.issueAccessToken('admin') };
        const issue = () => app.inject({ method: 'POST', url: '/v1/admin/employees/staff/invitations', headers, payload: {} });
        const activate = (code: string, extra = {}) => app.inject({ method: 'POST', url: '/v1/employee/activate', payload: { code, deviceName: 'PC', ...extra } });
        expect((await issue()).statusCode).toBe(400);
        await host.putAgent({ id: 'worker', ownerId: 'staff', companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [], preset: { id: 'company-worker', version: '0.1.0' } });
        const old = (await issue()).json();
        const fresh = (await issue()).json();
        expect((await activate(old.code)).statusCode).toBe(401);
        expect((await activate(fresh.code, { principalId: 'admin' })).statusCode).toBe(400);
        await host.db.pool.query("UPDATE employee_invitations SET expires_at=now()-interval '1 second'");
        expect((await activate(fresh.code)).statusCode).toBe(401);
        const disabledCode = (await issue()).json();
        await host.putActor({ id: 'staff', companyId: 'one', role: 'employee', permissions: [], active: false });
        expect((await activate(disabledCode.code)).statusCode).toBe(401);
        expect((await issue()).statusCode).toBe(403);
    } finally { await app.close(); await host.close(); }
});
