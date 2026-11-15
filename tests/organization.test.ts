import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';

test('concurrent organization writes do not exhaust the database connection pool while holding the organization lock', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/org-concurrent-')) });
    const app = await createServer(host);
    try {
        await host.putActor({ id: 'admin', companyId: 'one', role: 'admin', permissions: [] });
        const headers = { authorization: 'Bearer ' + await host.issueAccessToken('admin') };
        const results = await Promise.all(Array.from({ length: 12 }, (_, i) => app.inject({ method: 'POST', url: '/v1/admin/departments', headers, payload: { id: 'department-' + i, name: 'Test ' + i } })));
        expect(results.map(r => r.statusCode)).toEqual(Array(12).fill(201));
    } finally { await app.close(); await host.close(); }
}, 30000);

test('departments and reporting lines grant scoped team summaries, never private memory or platform administration', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/org-')) });
    const app = await createServer(host);
    try {
        await host.putActor({ id: 'admin', companyId: 'one', role: 'admin', permissions: [] });
        await host.putActor({ id: 'foreign', companyId: 'two', role: 'employee', permissions: [] });
        const headers = { authorization: 'Bearer ' + await host.issueAccessToken('admin') };
        const root = await app.inject({ method: 'POST', url: '/v1/admin/departments', headers, payload: { id: 'hq', name: '总部' } });
        expect(root.statusCode).toBe(201);
        const child = await app.inject({ method: 'POST', url: '/v1/admin/departments', headers, payload: { id: 'team', name: '测试部门', parentId: 'hq' } });
        expect(child.statusCode).toBe(201);
        const createEmployee = (id: string, extra: object) => app.inject({ method: 'POST', url: '/v1/admin/employees', headers, payload: { id, displayName: id, role: 'employee', permissions: [], ...extra } });
        expect((await createEmployee('chief', { departmentId: 'hq', teamScope: 'subtree', permissions: ['team.read', 'team.dispatch', 'team.review'] })).statusCode).toBe(201);
        expect((await createEmployee('lead', { departmentId: 'team', managerId: 'chief', teamScope: 'direct', permissions: ['team.read', 'team.dispatch', 'team.review'] })).statusCode).toBe(201);
        expect((await createEmployee('alice', { departmentId: 'team', managerId: 'lead' })).statusCode).toBe(201);
        expect((await createEmployee('bob', { departmentId: 'hq', managerId: 'chief' })).statusCode).toBe(201);
        const chiefHeaders = { authorization: 'Bearer ' + await host.issueAccessToken('chief') };
        const leadHeaders = { authorization: 'Bearer ' + await host.issueAccessToken('lead') };
        const chiefTeam = await app.inject({ url: '/v1/team', headers: chiefHeaders });
        expect(chiefTeam.statusCode).toBe(200);
        expect(chiefTeam.json().members.map((m: any) => m.id)).toEqual(expect.arrayContaining(['lead', 'alice', 'bob']));
        const leadTeam = await app.inject({ url: '/v1/team', headers: leadHeaders });
        expect(leadTeam.json().members.map((m: any) => m.id)).toContain('alice');
        expect(leadTeam.json().members.map((m: any) => m.id)).not.toContain('bob');
        expect(JSON.stringify(leadTeam.json())).not.toContain('permissions');
        expect((await app.inject({ url: '/v1/admin/employees', headers: leadHeaders })).statusCode).toBe(403);
        const employees = (await app.inject({ url: '/v1/admin/employees', headers })).json();
        const writable = ({ companyId, ...record }: any) => record;
        const chief = employees.find((e: any) => e.id === 'chief');
        expect((await app.inject({ method: 'PUT', url: '/v1/admin/employees/chief', headers, payload: { ...writable(chief), managerId: 'alice' } })).statusCode).toBe(409);
        const alice = employees.find((e: any) => e.id === 'alice');
        expect((await app.inject({ method: 'PUT', url: '/v1/admin/employees/alice', headers, payload: { ...writable(alice), managerId: 'foreign' } })).statusCode).toBe(403);
        expect((await app.inject({ method: 'PUT', url: '/v1/admin/departments/hq', headers, payload: { ...writable(root.json()), parentId: 'team' } })).statusCode).toBe(409);
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putAgent({ id: 'alice-agent', ownerId: 'alice', companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        await host.writeMemory({ principalId: 'alice', agentId: 'alice-agent', noteId: 'INDEX', expectedVersion: 0, sourceRefs: [], markdown: 'PRIVATE-ALICE' });
        expect((await app.inject({ url: '/v1/agents/alice-agent/memory/INDEX', headers: chiefHeaders })).statusCode).toBe(403);
        expect((await app.inject({ url: '/v1/agents/alice-agent/logs', headers: chiefHeaders })).statusCode).toBe(403);
    } finally { await app.close(); await host.close(); }
});
