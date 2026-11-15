import type { FastifyInstance } from 'fastify';
import type { Framework } from './index.js';
import type { Actor, Agent } from './types.js';
import { authenticateRequest } from './console-auth.js';
import { contentHash } from './contracts.js';
import { fail } from './errors.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { registerAdminObservability } from './admin-observability.js';
const identifier = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' };
const strings = { type: 'array', maxItems: 256, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 240 } };
const revision = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const binding = { type: 'object', additionalProperties: false, required: ['pluginId', 'pluginVersion'], properties: { pluginId: { type: 'string' }, pluginVersion: { type: 'string' }, config: { type: 'object' } } };
const actorBody = { type: 'object', additionalProperties: false, required: ['id', 'displayName', 'role', 'permissions'], properties: { id: identifier, displayName: { type: 'string', minLength: 1, maxLength: 80 }, department: { type: 'string', maxLength: 80 }, departmentId: { anyOf: [identifier, { type: 'null' }] }, managerId: { anyOf: [identifier, { type: 'null' }] }, teamScope: { enum: ['none', 'direct', 'subtree'] }, role: { enum: ['admin', 'employee'] }, permissions: { ...strings, items: { type: 'string', maxLength: 240, pattern: '^(?:tool\\.invoke:@[a-z0-9-]+/[a-z0-9-]+:[a-z][a-z0-9_.-]+|(?:agent\\.(?:read|execute)|memory\\.(?:read|execute)):[A-Za-z0-9][A-Za-z0-9_-]{0,63}|memory\\.self\\.(?:read|propose_write)|report\\.self\\.write|team\\.(?:read|dispatch|review)|work\\.(?:read|dispatch)|reminder\\.(?:read|write)|inbox\\.self\\.read|event\\.self\\.publish|connection\\.catalog\\.read)$' } }, active: { type: 'boolean' }, revision } };
const agentBody = { type: 'object', additionalProperties: false, required: ['id', 'ownerId', 'pluginId', 'pluginVersion', 'allowedTools'], properties: { preset: { type: 'object', additionalProperties: false, required: ['id', 'version'], properties: { id: { type: 'string', maxLength: 80 }, version: { type: 'string', maxLength: 40 } } }, id: identifier, displayName: { type: 'string', minLength: 1, maxLength: 80 }, ownerId: identifier, pluginId: { type: 'string' }, pluginVersion: { type: 'string' }, config: { type: 'object' }, plugins: { type: 'array', maxItems: 15, items: binding }, allowedTools: strings, servicePermissions: strings, instructions: { type: 'string', maxLength: 8000 }, runtime: { enum: ['harness', 'remote'] }, connectionRef: { type: 'string', maxLength: 100 }, delegates: { ...strings, maxItems: 16 }, active: { type: 'boolean' }, reason: { type: 'string', maxLength: 1000 }, revision } };
const versioned = <T extends object>(record: T) => ({ ...record, revision: contentHash(record) });
export async function requireAdmin(host: Framework, principalId: string, client?: Pick<PoolClient, 'query'>) { const actor = await host.db.get<Actor>('actors', principalId, client); if (!actor.active || actor.role !== 'admin')
    fail('PERMISSION_DENIED', 'Administrator access is required'); return actor; }
export class AdminControl {
    constructor(readonly host: Framework) { }
    async employees(principalId: string) { const admin = await requireAdmin(this.host, principalId); return (await this.host.db.list<Actor>('actors')).filter(a => a.companyId === admin.companyId).map(versioned); }
    async agents(principalId: string) { const admin = await requireAdmin(this.host, principalId); const actors = new Map((await this.host.db.list<Actor>('actors')).map(a => [a.id, a])); return (await this.host.db.list<Agent>('agents')).filter(a => a.companyId === admin.companyId).map(agent => { const owner = actors.get(agent.ownerId); const enabled = new Set(this.host.bindings(agent).flatMap(b => { const p = this.host.registry.list().find(p => p.id === b.pluginId && p.version === b.pluginVersion); return p?.enabled ? p.manifest.provides.tools.map(t => p.id + ':' + t.id) : []; })); return { ...versioned(agent), effectiveTools: agent.active && owner?.active ? agent.allowedTools.filter(ref => enabled.has(ref) && (owner.role === 'admin' || owner.permissions.includes('tool.invoke:' + ref))) : [] }; }); }
    async setAgentActive(principalId: string, id: string, active: boolean, expected: string) { const admin = await requireAdmin(this.host, principalId); const client = await this.host.db.pool.connect(); try {
        await client.query('BEGIN');
        const prior = (await client.query('SELECT data FROM agents WHERE id=$1 FOR UPDATE', [id])).rows[0]?.data as Agent | undefined;
        if (!prior)
            fail('NOT_FOUND', 'Agent does not exist');
        if (prior.companyId !== admin.companyId)
            fail('PERMISSION_DENIED', 'Agent belongs to another company');
        if (contentHash(prior) !== expected)
            fail('CONFLICT', 'Agent changed; reload before saving');
        if (active) {
            const owner = await this.host.db.get<Actor>('actors', prior.ownerId);
            if (!owner.active)
                fail('PERMISSION_DENIED', 'Enable the owner account first');
            for (const b of this.host.bindings(prior))
                this.host.registry.get(b.pluginId, b.pluginVersion);
            const running = (await client.query("SELECT count(*)::int AS n FROM runs WHERE agent_id=$1 AND state='running'", [id])).rows[0].n;
            if (running)
                fail('CONFLICT', 'Wait for interrupted work to stop before re-enabling');
        }
        const next = { ...prior, active };
        await client.query('UPDATE agents SET data=$2 WHERE id=$1', [id, JSON.stringify(next)]);
        await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'agent.state_changed', JSON.stringify({ principalId: admin.id, companyId: admin.companyId, agentId: id, active })]);
        await client.query('COMMIT');
        return versioned(next);
    }
    catch (e) {
        await client.query('ROLLBACK');
        throw e;
    }
    finally {
        client.release();
    } }
    async saveEmployee(principalId: string, input: any, create: boolean) {
        const admin = await requireAdmin(this.host, principalId);
        const { revision: expected, ...fields } = input;
        const next: Actor = { ...fields, companyId: admin.companyId, active: fields.active !== false, department: fields.department ?? '' };
        const client = await this.host.db.pool.connect();
        try {
            await client.query('BEGIN');
            await this.host.organization.lock(client);
            await requireAdmin(this.host, principalId, client);
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.host.db.schema + ':employees']);
            const prior = (await client.query('SELECT data FROM actors WHERE id=$1 FOR UPDATE', [next.id])).rows[0]?.data as Actor | undefined;
            if (create && prior)
                fail('CONFLICT', 'Employee id already exists');
            if (!create && !prior)
                fail('NOT_FOUND', 'Employee does not exist');
            if (prior?.companyId !== undefined && prior.companyId !== admin.companyId)
                fail('PERMISSION_DENIED', 'Employee belongs to another company');
            if (prior && !create && contentHash(prior) !== expected)
                fail('CONFLICT', 'Employee changed; reload before saving');
            for (const field of ['departmentId', 'managerId', 'teamScope'] as const) if (!(field in fields) && prior && prior[field] !== undefined) (next as any)[field] = prior[field];
            await this.host.organization.validateActor(next, client);
            if (next.id === admin.id && (next.active === false || next.role !== 'admin'))
                fail('CONFLICT', 'Keep the signed-in administrator active');
            await client.query('INSERT INTO actors(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', [next.id, JSON.stringify(next)]);
            await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), create ? 'employee.created' : 'employee.updated', JSON.stringify({ principalId: admin.id, targetPrincipalId: next.id, companyId: admin.companyId, active: next.active, role: next.role })]);
            await client.query('COMMIT');
            return versioned(next);
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    async saveAgent(principalId: string, input: any, create: boolean) {
        const admin = await requireAdmin(this.host, principalId);
        const { revision: expected, reason, ...fields } = input;
        const next: Agent = { ...fields, companyId: admin.companyId, active: fields.active !== false };
        const owner = await this.host.db.get<Actor>('actors', next.ownerId);
        if (owner.companyId !== admin.companyId || (!owner.active && next.active))
            fail('PERMISSION_DENIED', 'Select an active employee from this company');
        await this.host.validateAgent(next);
        for (const b of this.host.bindings(next))
            await this.host.validatePlugin(b.pluginId, b.pluginVersion, b.config ?? {}, next.ownerId);
        const plugins = this.host.bindings(next).map(b => this.host.registry.get(b.pluginId, b.pluginVersion));
        const declared = new Set(plugins.flatMap(p => p.manifest.provides.tools.map(t => p.id + ':' + t.id)));
        if (next.allowedTools.some(t => !declared.has(t)))
            fail('INVALID_INPUT', 'A granted tool is not mounted');
        const services = new Set(plugins.flatMap(p => p.manifest.permissions));
        if (next.servicePermissions?.some(p => !services.has(p)))
            fail('INVALID_INPUT', 'A service permission is not declared by a mounted plugin');
        if (next.runtime === 'remote' && !this.host.options.connections?.[next.connectionRef ?? ''])
            fail('INVALID_INPUT', 'Remote connection is not configured');
        for (const id of next.delegates ?? []) {
            const target = await this.host.db.get<Agent>('agents', id);
            if (id === next.id || target.companyId !== admin.companyId)
                fail('PERMISSION_DENIED', 'Delegation target is outside allowed scope');
        }
        const client = await this.host.db.pool.connect();
        try {
            await client.query('BEGIN');
            const prior = (await client.query('SELECT data FROM agents WHERE id=$1 FOR UPDATE', [next.id])).rows[0]?.data as Agent | undefined;
            if (create && prior)
                fail('CONFLICT', 'Agent id already exists');
            if (!create && !prior)
                fail('NOT_FOUND', 'Agent does not exist');
            if (prior && prior.companyId !== admin.companyId)
                fail('PERMISSION_DENIED', 'Agent belongs to another company');
            if (prior && contentHash(prior) !== expected)
                fail('CONFLICT', 'Agent changed; reload before saving');
            if (prior && prior.ownerId !== next.ownerId)
                fail('CONFLICT', 'Create a new Agent to change ownership without transferring private memory');
            if (prior?.preferences)
                next.preferences = prior.preferences;
            const running = (await client.query("SELECT count(*)::int AS n FROM runs WHERE agent_id=$1 AND state='running'", [next.id])).rows[0].n;
            if (running || this.host.hasActiveInvocation(next.id))
                fail('CONFLICT', 'Wait for active work to finish before changing the Agent');
            await client.query('INSERT INTO agents(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', [next.id, JSON.stringify(next)]);
            await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), create ? 'agent.created' : 'agent.updated', JSON.stringify({ principalId: admin.id, agentId: next.id, companyId: admin.companyId, ownerId: next.ownerId, bindings: this.host.bindings(next).map(b => ({ pluginId: b.pluginId, version: b.pluginVersion })), active: next.active, reason: reason ?? (create ? '创建岗位' : '调整岗位配置') })]);
            await client.query('COMMIT');
            return versioned(next);
        }
        catch (error) {
            await client.query('ROLLBACK');
            if ((error as any).code === '23505')
                fail('CONFLICT', 'Agent id already exists');
            throw error;
        }
        finally {
            client.release();
        }
    }
}
export function registerAdmin(app: FastifyInstance, host: Framework) {
    const control = new AdminControl(host);
    app.register(async (api) => {
        api.addHook('preHandler', async (request) => { const actor = await authenticateRequest(host, request); await requireAdmin(host, actor.id); (request as any).principalId = actor.id; });
        registerAdminObservability(api, host);
        const principal = (request: any) => request.principalId as string;
        api.get('/employees', async (request) => control.employees(principal(request)));
        api.post('/employees', { schema: { body: actorBody } }, async (request, reply) => reply.code(201).send(await control.saveEmployee(principal(request), request.body, true)));
        api.put<{
            Params: {
                id: string;
            };
        }>('/employees/:id', { schema: { body: actorBody } }, async (request) => { if ((request.body as any).id !== request.params.id)
            fail('INVALID_INPUT', 'Employee id cannot change'); return control.saveEmployee(principal(request), request.body, false); });
        api.get('/agents', async (request) => control.agents(principal(request)));
        api.post<{
            Params: {
                id: string;
            };
        }>('/agents/:id/state', { schema: { body: { type: 'object', additionalProperties: false, required: ['active', 'revision'], properties: { active: { type: 'boolean' }, revision } } } }, async (request) => { const body = request.body as any; return control.setAgentActive(principal(request), request.params.id, body.active, body.revision); });
        api.post('/agents', { schema: { body: agentBody } }, async (request, reply) => reply.code(201).send(await control.saveAgent(principal(request), request.body, true)));
        api.put<{
            Params: {
                id: string;
            };
        }>('/agents/:id', { schema: { body: agentBody } }, async (request) => { if ((request.body as any).id !== request.params.id)
            fail('INVALID_INPUT', 'Agent id cannot change'); return control.saveAgent(principal(request), request.body, false); });
        api.post<{
            Params: {
                id: string;
            };
        }>('/agents/:id/try', { schema: { body: { type: 'object', additionalProperties: false, required: ['toolRef', 'input', 'idempotencyKey'], properties: { toolRef: { type: 'string' }, input: {}, idempotencyKey: { type: 'string', minLength: 1, maxLength: 160 } } } } }, async (request) => { const admin = await requireAdmin(host, principal(request)); const agent = await host.db.get<Agent>('agents', request.params.id); if (agent.companyId !== admin.companyId)
            fail('PERMISSION_DENIED', 'Agent belongs to another company'); await host.db.audit('admin.tool_test', { principalId: admin.id, agentId: agent.id, targetPrincipalId: agent.ownerId }); return host.invoke({ ...request.body as any, agentId: agent.id, principalId: agent.ownerId }); });
    }, { prefix: '/v1/admin' });
}
