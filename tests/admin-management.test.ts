import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
test('administrators manage employees and agents with company scope and optimistic revisions', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/admin-')) });
    const app = await createServer(host);
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'admin', companyId: 'one', role: 'admin', permissions: [] });
        await host.putActor({ id: 'outsider', companyId: 'two', role: 'employee', permissions: [] });
        const headers = { authorization: 'Bearer ' + await host.issueAccessToken('admin') };
        const employee = { id: 'new-employee', displayName: '测试员工', department: '验证部门', role: 'employee', permissions: ['tool.invoke:@example/conformance:text.normalize'] };
        expect((await app.inject({ method: 'POST', url: '/v1/admin/employees', headers, payload: { ...employee, id: 'invalid-grant', permissions: ['@example/conformance:text.normalize'] } })).statusCode).toBe(400);
        const created = await app.inject({ method: 'POST', url: '/v1/admin/employees', headers, payload: employee });
        expect(created.statusCode).toBe(201);
        expect(created.json().companyId).toBe('one');
        expect(created.json().revision).toBeTruthy();
        const list = (await app.inject({ url: '/v1/admin/employees', headers })).json();
        expect(list.map((a: any) => a.id)).not.toContain('outsider');
        const updated = await app.inject({ method: 'PUT', url: '/v1/admin/employees/new-employee', headers, payload: { ...employee, displayName: '已更新', revision: created.json().revision } });
        expect(updated.statusCode).toBe(200);
        expect((await app.inject({ method: 'PUT', url: '/v1/admin/employees/new-employee', headers, payload: { ...employee, revision: created.json().revision } })).statusCode).toBe(409);
        const staffHeaders = { authorization: 'Bearer ' + await host.issueAccessToken('new-employee') };
        expect((await app.inject({ url: '/v1/admin/employees', headers: staffHeaders })).statusCode).toBe(403);
        const agent = { id: 'new-agent', displayName: '验证助手', ownerId: 'new-employee', pluginId: '@example/conformance', pluginVersion: '0.1.0', config: {}, allowedTools: ['@example/conformance:text.normalize'], servicePermissions: [] };
        const mounted = await app.inject({ method: 'POST', url: '/v1/admin/agents', headers, payload: agent });
        expect(mounted.statusCode).toBe(201);
        expect((await app.inject({ method: 'POST', url: '/v1/admin/agents/new-agent/try', headers, payload: { toolRef: '@example/conformance:text.normalize', input: { text: ' actual   kernel ' }, idempotencyKey: 'ui-check' } })).json().output).toEqual({ text: 'actual kernel' });
        const disabled = await app.inject({ method: 'PUT', url: '/v1/admin/agents/new-agent', headers, payload: { ...agent, active: false, revision: mounted.json().revision } });
        expect(disabled.statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/v1/invoke', headers: staffHeaders, payload: { agentId: 'new-agent', toolRef: '@example/conformance:text.normalize', input: { text: 'x' }, idempotencyKey: 'disabled' } })).statusCode).toBe(403);
        expect((await app.inject({ url: '/v1/agents/new-agent/logs', headers })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/v1/admin/agents/new-agent/state', headers, payload: { active: true, revision: disabled.json().revision } })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/v1/admin/agents', headers, payload: { ...agent, id: 'cross-company', ownerId: 'outsider' } })).statusCode).toBe(403);
    }
    finally {
        await app.close();
        await host.close();
    }
});
