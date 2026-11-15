import type { Framework } from './index.js';
import type { Actor, Agent } from './types.js';
import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { contentHash } from './contracts.js';
import { authenticateRequest } from './console-auth.js';
import { requireAdmin } from './admin.js';
import { fail } from './errors.js';

export interface Department { id: string; companyId: string; name: string; parentId?: string | null; active: boolean; }
type Queryable = Pick<PoolClient, 'query'>;
const identifier = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' };
const departmentBody = { type: 'object', additionalProperties: false, required: ['id', 'name'], properties: {
    id: identifier, name: { type: 'string', minLength: 1, maxLength: 80 }, parentId: { anyOf: [identifier, { type: 'null' }] }, active: { type: 'boolean' }, revision: { type: 'string', pattern: '^[a-f0-9]{64}$' }
} };
export class Organization {
    constructor(readonly host: Framework) {}
    async lock(client: Queryable) { await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.host.db.schema + ':organization']); }
    async validateActor(actor: Actor, client: Queryable = this.host.db.pool) {
        if (actor.teamScope && !['none', 'direct', 'subtree'].includes(actor.teamScope)) fail('INVALID_INPUT', 'Invalid team scope');
        if (actor.departmentId) {
            const row = (await client.query('SELECT data FROM departments WHERE id=$1', [actor.departmentId])).rows[0];
            if (!row || row.data.companyId !== actor.companyId) fail('PERMISSION_DENIED', 'Department must belong to the same company');
            if (!row.data.active) fail('INVALID_INPUT', 'Select an active department');
        }
        if (!actor.managerId) return;
        const rows = (await client.query('SELECT id,data FROM actors')).rows;
        const actors = new Map<string, Actor>(rows.map(row => [row.id, row.data]));
        const manager = actors.get(actor.managerId);
        if (!manager || manager.companyId !== actor.companyId) fail('PERMISSION_DENIED', 'Manager must belong to the same company');
        if (!manager.active) fail('INVALID_INPUT', 'Select an active manager');
        actors.set(actor.id, actor);
        const seen = new Set([actor.id]);
        let next: string | null | undefined = actor.managerId;
        while (next) {
            if (seen.has(next)) fail('CONFLICT', 'Reporting lines must not contain a cycle');
            seen.add(next);
            const parent = actors.get(next);
            if (!parent || parent.companyId !== actor.companyId) fail('PERMISSION_DENIED', 'Reporting line left company scope');
            next = parent.managerId;
        }
    }
    async permits(principalId: string, targetId: string, operation: 'read' | 'dispatch' | 'review', client: Queryable = this.host.db.pool) {
        const rows = (await client.query('SELECT id,data FROM actors WHERE id=$1 OR id=$2 OR data->>\'companyId\'=(SELECT data->>\'companyId\' FROM actors WHERE id=$1)', [principalId, targetId])).rows;
        const actors = new Map<string, Actor>(rows.map(row => [row.id, row.data]));
        const actor = actors.get(principalId), target = actors.get(targetId);
        if (!actor?.active || !target || actor.companyId !== target.companyId) return false;
        if (actor.role === 'admin' || actor.id === target.id) return true;
        if (!actor.permissions.includes('team.' + operation) || !actor.teamScope || actor.teamScope === 'none') return false;
        let manager = target.managerId;
        const seen = new Set<string>();
        while (manager && !seen.has(manager)) {
            if (manager === actor.id) return true;
            if (actor.teamScope === 'direct') return false;
            seen.add(manager);
            const next = actors.get(manager);
            if (!next || next.companyId !== actor.companyId) return false;
            manager = next.managerId;
        }
        return false;
    }
    async authorize(principalId: string, targetId: string, operation: 'read' | 'dispatch' | 'review', client?: Queryable) {
        if (!await this.permits(principalId, targetId, operation, client)) fail('PERMISSION_DENIED', 'Employee is outside the current authorized team scope');
    }
    async authorizeAgent(principalId: string, agentId: string, operation: 'read' | 'dispatch' | 'review', client: Queryable = this.host.db.pool) {
        const actor = (await client.query('SELECT data FROM actors WHERE id=$1', [principalId])).rows[0]?.data as Actor | undefined;
        const agent = (await client.query('SELECT data FROM agents WHERE id=$1', [agentId])).rows[0]?.data as Agent | undefined;
        if (!actor?.active || !agent || actor.companyId !== agent.companyId) fail('PERMISSION_DENIED', 'Work Agent is outside company scope');
        const owner = (await client.query('SELECT data FROM actors WHERE id=$1', [agent.ownerId])).rows[0]?.data as Actor | undefined;
        if (!owner || owner.companyId !== actor.companyId || (operation === 'dispatch' && (!owner.active || !agent.active))) fail('PERMISSION_DENIED', 'Work owner or Agent is unavailable');
        const explicit = operation !== 'review' && actor.permissions.includes('agent.' + (operation === 'dispatch' ? 'execute' : 'read') + ':' + agent.id);
        if (!explicit) await this.authorize(actor.id, owner.id, operation, client);
        return { actor, agent };
    }
    async team(principalId: string) {
        const me = await this.host.db.get<Actor>('actors', principalId);
        if (!me.active) fail('UNAUTHENTICATED', 'Employee is inactive');
        const visible: Actor[] = [];
        for (const actor of await this.host.db.list<Actor>('actors')) if (actor.companyId === me.companyId && await this.permits(me.id, actor.id, 'read')) visible.push(actor);
        const ids = new Set(visible.map(a => a.id));
        const departments = (await this.host.db.pool.query("SELECT data FROM departments WHERE data->>'companyId'=$1 ORDER BY id", [me.companyId])).rows.map(r => r.data);
        const agents = (await this.host.db.list<Agent>('agents')).filter(a => a.companyId === me.companyId && ids.has(a.ownerId)).map(a => ({ id: a.id, displayName: a.displayName ?? a.id, ownerId: a.ownerId, active: a.active }));
        return { departments, members: visible.map(a => ({ id: a.id, displayName: a.displayName ?? a.id, departmentId: a.departmentId ?? null, managerId: a.managerId ?? null, active: a.active })), agents };
    }
    async departments(principalId: string) {
        const admin = await requireAdmin(this.host, principalId);
        return (await this.host.db.pool.query("SELECT data FROM departments WHERE data->>'companyId'=$1 ORDER BY id", [admin.companyId])).rows.map(({ data }) => ({ ...data, revision: contentHash(data) }));
    }
    async saveDepartment(principalId: string, input: Omit<Department, 'companyId' | 'active'> & { active?: boolean; revision?: string }, create: boolean) {
        const client = await this.host.db.pool.connect();
        try {
            await client.query('BEGIN'); await this.lock(client);
            const admin = await requireAdmin(this.host, principalId, client);
            const all = (await client.query('SELECT id,data FROM departments')).rows;
            const departments = new Map<string, Department>(all.map(row => [row.id, row.data]));
            const prior = departments.get(input.id);
            if (create && prior) fail('CONFLICT', 'Department already exists');
            if (!create && !prior) fail('NOT_FOUND', 'Department does not exist');
            if (prior && prior.companyId !== admin.companyId) fail('PERMISSION_DENIED', 'Department belongs to another company');
            if (prior && contentHash(prior) !== input.revision) fail('CONFLICT', 'Department changed; reload before saving');
            const next: Department = { id: input.id, name: input.name, parentId: input.parentId ?? null, companyId: admin.companyId, active: input.active !== false };
            departments.set(next.id, next);
            const seen = new Set([next.id]);
            let id = next.parentId;
            while (id) {
                if (seen.has(id)) fail('CONFLICT', 'Department hierarchy must not contain a cycle');
                seen.add(id);
                const parent = departments.get(id);
                if (!parent || parent.companyId !== admin.companyId) fail('PERMISSION_DENIED', 'Parent department must belong to the same company');
                if (!parent.active) fail('INVALID_INPUT', 'Select an active parent department');
                id = parent.parentId;
            }
            await client.query('INSERT INTO departments(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', [next.id, JSON.stringify(next)]);
            await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'department.' + (create ? 'created' : 'updated'), JSON.stringify({ principalId: admin.id, companyId: admin.companyId, departmentId: next.id, parentId: next.parentId })]);
            await client.query('COMMIT'); return { ...next, revision: contentHash(next) };
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    registerRoutes(app: FastifyInstance) {
        app.get('/v1/team', async request => this.team((await authenticateRequest(this.host, request)).id));
        app.get('/v1/admin/departments', async request => this.departments((await authenticateRequest(this.host, request)).id));
        app.post('/v1/admin/departments', { schema: { body: departmentBody } }, async (request, reply) => reply.code(201).send(await this.saveDepartment((await authenticateRequest(this.host, request)).id, request.body as any, true)));
        app.put<{ Params: { id: string } }>('/v1/admin/departments/:id', { schema: { body: departmentBody } }, async request => {
            if ((request.body as any).id !== request.params.id) fail('INVALID_INPUT', 'Department id cannot change');
            return this.saveDepartment((await authenticateRequest(this.host, request)).id, request.body as any, false);
        });
    }
}
