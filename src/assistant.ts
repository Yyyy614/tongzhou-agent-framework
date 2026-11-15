import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { Framework } from './index.js';
import type { WorkCoordinator } from './work.js';
import type { Actor } from './types.js';
import { contentHash, requireUuid, zonedTimestamp } from './contracts.js';
import { fail } from './errors.js';
import { authenticateRequest } from './console-auth.js';
import { requireAdmin } from './admin.js';

export const subjectRefSchema = { type: 'object', additionalProperties: false, required: ['system', 'id'], properties: { system: { type: 'string', minLength: 1, maxLength: 80 }, id: { type: 'string', minLength: 1, maxLength: 160 } } };
export interface ReminderRequest { agentId: string; title: string; dueAt: string; details?: string; subjectRef?: { system: string; id: string }; idempotencyKey: string; sourceAgentId?: string; sourceToolRef?: string; sourcePluginVersion?: string; }
export const reminderBody = { type: 'object', additionalProperties: false, required: ['agentId', 'title', 'dueAt', 'idempotencyKey'], properties: {
    agentId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }, title: { type: 'string', minLength: 1, maxLength: 160 }, dueAt: { type: 'string', minLength: 10, maxLength: 40 }, details: { type: 'string', maxLength: 2000 }, subjectRef: subjectRefSchema, idempotencyKey: { type: 'string', minLength: 1, maxLength: 160 }
} };
export interface EventRequest { agentId: string; type: string; summary: string; subjectRef?: { system: string; id: string }; idempotencyKey: string; }
export const eventBody = { type: 'object', additionalProperties: false, required: ['agentId', 'type', 'summary', 'idempotencyKey'], properties: {
    agentId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }, type: { type: 'string', pattern: '^[a-z][a-z0-9_.-]{0,79}$' }, summary: { type: 'string', minLength: 1, maxLength: 2400 }, subjectRef: subjectRefSchema, idempotencyKey: { type: 'string', minLength: 1, maxLength: 160 }
} };
export interface AssistantRule { id: string; eventType: string; sourcePrincipalIds: string[]; assignments: Array<{ agentId: string; prompt: string }>; enabled: boolean; revision?: string; }
const ruleBody = { type: 'object', additionalProperties: false, required: ['id', 'eventType', 'sourcePrincipalIds', 'assignments'], properties: {
    id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }, eventType: { type: 'string', pattern: '^[a-z][a-z0-9_.-]{0,79}$' }, sourcePrincipalIds: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' } }, assignments: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['agentId', 'prompt'], properties: { agentId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }, prompt: { type: 'string', minLength: 1, maxLength: 2000 } } } }, enabled: { type: 'boolean' }, revision: { type: 'string', pattern: '^[a-f0-9]{64}$' }
} };
export class WorkAssistant {
    private timer?: ReturnType<typeof setTimeout>;
    private running?: Promise<void>;
    private stopped = true;
    constructor(readonly host: Framework, readonly work: WorkCoordinator) { host.assistant = this; }
    async requireCapability(principalId: string, permission: string, client?: Pick<PoolClient, 'query'>) {
        const actor = await this.host.db.get<Actor>('actors', principalId, client);
        if (!actor.active || (actor.role !== 'admin' && !actor.permissions.includes(permission))) fail('PERMISSION_DENIED', 'Work assistant capability is not granted');
        return actor;
    }
    private reminder(row: any) { return { id: row.id, agentId: row.agent_id, ownerId: row.principal_id, createdBy: row.created_by, dueAt: row.due_at, state: row.state, ...row.data, createdAt: row.created_at }; }
    async createReminder(principalId: string, input: ReminderRequest) {
        zonedTimestamp(input.dueAt);
        if (!input.title?.trim() || input.title.length > 160 || !input.idempotencyKey || input.idempotencyKey.length > 160 || (input.details?.length ?? 0) > 2000) fail('INVALID_INPUT', 'Invalid reminder');
        const client = await this.host.db.pool.connect();
        try {
            await client.query('BEGIN'); await this.host.organization.lock(client);
            const actor = await this.requireCapability(principalId, 'reminder.write', client);
            const { agent } = await this.host.organization.authorizeAgent(actor.id, input.agentId, 'dispatch', client);
            if (input.sourceAgentId) {
                await this.host.authorizeHostCapability(actor.id, input.sourceAgentId, input.sourceToolRef!, 'reminder.write', input.sourcePluginVersion, client);
                const source = await this.host.authorize(actor.id, input.sourceAgentId, 'execute', client);
                if (source.agent.ownerId !== actor.id || (source.agent.id !== agent.id && !source.agent.delegates?.includes(agent.id))) fail('PERMISSION_DENIED', 'Reminder target is not granted to the source Agent');
            }
            const key = contentHash(['reminder', actor.id, input.idempotencyKey]), hash = contentHash(input);
            let row = (await client.query('SELECT * FROM assistant_reminders WHERE request_key=$1', [key])).rows[0];
            if (row) { if (row.input_hash !== hash) fail('CONFLICT', 'Reminder key reused with different input'); }
            else {
                row = (await client.query('INSERT INTO assistant_reminders(id,company_id,principal_id,created_by,agent_id,due_at,state,request_key,input_hash,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [randomUUID(), actor.companyId, agent.ownerId, actor.id, agent.id, new Date(input.dueAt), 'pending', key, hash, JSON.stringify({ title: input.title.trim(), details: input.details ?? '', subjectRef: input.subjectRef ?? null, sourceAgentId: input.sourceAgentId ?? null, sourceToolRef: input.sourceToolRef ?? null, sourcePluginVersion: input.sourcePluginVersion ?? null })])).rows[0];
                await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'reminder.scheduled', JSON.stringify({ principalId: actor.id, companyId: actor.companyId, agentId: agent.id, reminderId: row.id, dueAt: input.dueAt })]);
            }
            await client.query('COMMIT'); return this.reminder(row);
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    async reminders(principalId: string, administrative = false) {
        const actor = await this.host.db.get<Actor>('actors', principalId);
        if (!actor.active) fail('PERMISSION_DENIED', 'Employee is inactive');
        if (administrative) await requireAdmin(this.host, principalId);
        return (await this.host.db.pool.query('SELECT * FROM assistant_reminders WHERE company_id=$1 AND ($3::boolean OR principal_id=$2 OR created_by=$2) ORDER BY due_at DESC LIMIT 100', [actor.companyId, actor.id, administrative])).rows.map(row => this.reminder(row));
    }
    async cancelReminder(principalId: string, id: string) {
        requireUuid(id);
        const client = await this.host.db.pool.connect();
        try {
            await client.query('BEGIN'); await this.host.organization.lock(client);
            const actor = await this.requireCapability(principalId, 'reminder.write', client);
            const row = (await client.query('SELECT * FROM assistant_reminders WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, actor.companyId])).rows[0];
            if (!row) fail('NOT_FOUND', 'Reminder does not exist');
            if (row.principal_id !== actor.id) await this.host.organization.authorizeAgent(actor.id, row.agent_id, 'dispatch', client);
            if (row.state === 'delivered') fail('CONFLICT', 'Reminder was already delivered');
            const updated = (await client.query("UPDATE assistant_reminders SET state='cancelled' WHERE id=$1 RETURNING *", [id])).rows[0];
            await client.query('COMMIT'); return this.reminder(updated);
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    async inbox(principalId: string) {
        const actor = await this.requireCapability(principalId, 'inbox.self.read');
        return (await this.host.db.pool.query('SELECT id,kind,data,read_at AS "readAt",created_at AS "createdAt" FROM assistant_inbox WHERE company_id=$1 AND principal_id=$2 ORDER BY created_at DESC LIMIT 100', [actor.companyId, actor.id])).rows;
    }
    async deliver(client: PoolClient, companyId: string, principalId: string, key: string, kind: string, data: unknown) {
        await client.query('INSERT INTO assistant_inbox(id,company_id,principal_id,key,kind,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(key) DO NOTHING', [randomUUID(), companyId, principalId, contentHash([companyId, principalId, key]), kind, JSON.stringify(data)]);
    }
    async publishEvent(principalId: string, input: EventRequest, source = 'employee:' + principalId, metadata: { noAutomation?: boolean; originWorkId?: string } = {}) {
        if (!this.host.registry.ajv.validate(eventBody, input)) fail('INVALID_INPUT', 'Event does not satisfy the common event contract');
        if (input.type.startsWith('work.') && input.type !== 'work.issue' && input.type !== 'work.unmatched') fail('INVALID_INPUT', 'Work system events are reserved for trusted task monitoring');
        const client = await this.host.db.pool.connect();
        try {
            await client.query('BEGIN'); await this.host.organization.lock(client);
            const actor = await this.requireCapability(principalId, 'event.self.publish', client);
            const scope = await this.host.authorize(actor.id, input.agentId, 'execute', client);
            if (actor.role !== 'admin' && scope.agent.ownerId !== actor.id) fail('PERMISSION_DENIED', 'Only an owned Agent can publish an employee event');
            const key = contentHash(['event', actor.id, source, input.idempotencyKey]), hash = contentHash(input);
            let row = (await client.query('SELECT * FROM assistant_events WHERE request_key=$1', [key])).rows[0];
            if (row) { if (row.input_hash !== hash) fail('CONFLICT', 'Event key reused with different input'); }
            else {
                row = (await client.query('INSERT INTO assistant_events(id,company_id,created_by,agent_id,source,type,state,request_key,input_hash,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [randomUUID(), actor.companyId, actor.id, scope.agent.id, source, input.type, 'pending', key, hash, JSON.stringify({ summary: input.summary, subjectRef: input.subjectRef ?? null, ...metadata })])).rows[0];
                await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'assistant.event_received', JSON.stringify({ principalId: actor.id, companyId: actor.companyId, agentId: scope.agent.id, eventId: row.id, eventType: input.type, source })]);
            }
            await client.query('COMMIT'); return { id: row.id, source: row.source, type: row.type, state: row.state, workIds: row.data.workIds ?? [] };
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    async rules(principalId: string) {
        const actor = await requireAdmin(this.host, principalId);
        return (await this.host.db.pool.query('SELECT * FROM assistant_rules WHERE company_id=$1 ORDER BY id', [actor.companyId])).rows.map(row => ({ id: row.id, ...row.data, createdBy: row.created_by, revision: contentHash(row.data) }));
    }
    async saveRule(principalId: string, input: AssistantRule, create: boolean) {
        if (!this.host.registry.ajv.validate(ruleBody, input)) fail('INVALID_INPUT', 'Invalid assistant rule');
        const client = await this.host.db.pool.connect();
        try {
            await client.query('BEGIN'); await this.host.organization.lock(client);
            const actor = await requireAdmin(this.host, principalId, client);
            const prior = (await client.query('SELECT * FROM assistant_rules WHERE id=$1 FOR UPDATE', [input.id])).rows[0];
            if (create && prior) fail('CONFLICT', 'Rule already exists');
            if (!create && !prior) fail('NOT_FOUND', 'Rule does not exist');
            if (prior && prior.company_id !== actor.companyId) fail('PERMISSION_DENIED', 'Rule belongs to another company');
            if (prior && input.revision !== contentHash(prior.data)) fail('CONFLICT', 'Rule changed; reload before saving');
            for (const id of input.sourcePrincipalIds) {
                const source = (await client.query('SELECT data FROM actors WHERE id=$1', [id])).rows[0]?.data;
                if (!source || source.companyId !== actor.companyId) fail('PERMISSION_DENIED', 'Event sources must belong to the same company');
            }
            if (new Set(input.assignments.map(a => a.agentId)).size !== input.assignments.length) fail('INVALID_INPUT', 'Rule targets must be distinct');
            for (const item of input.assignments) await this.host.organization.authorizeAgent(actor.id, item.agentId, input.enabled === false ? 'read' : 'dispatch', client);
            const data = { eventType: input.eventType, sourcePrincipalIds: input.sourcePrincipalIds, assignments: input.assignments, enabled: input.enabled !== false };
            await client.query('INSERT INTO assistant_rules(id,company_id,created_by,data) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,created_by=EXCLUDED.created_by', [input.id, actor.companyId, actor.id, JSON.stringify(data)]);
            await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'assistant.rule_saved', JSON.stringify({ principalId: actor.id, companyId: actor.companyId, ruleId: input.id, revision: contentHash(data) })]);
            await client.query('COMMIT'); return { id: input.id, ...data, createdBy: actor.id, revision: contentHash(data) };
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    private async processEvents(client: PoolClient) {
        const events = (await client.query("SELECT * FROM assistant_events WHERE state='pending' ORDER BY created_at LIMIT 25 FOR UPDATE SKIP LOCKED")).rows;
        for (const event of events) {
            await client.query('SAVEPOINT event_processing');
            try {
                const actor = (await client.query('SELECT data FROM actors WHERE id=$1', [event.created_by])).rows[0]?.data as Actor | undefined;
                if (!actor?.active || actor.companyId !== event.company_id || (event.source !== 'framework:work' && actor.role !== 'admin' && !actor.permissions.includes('event.self.publish'))) fail('PERMISSION_DENIED', 'Event producer is no longer authorized');
                const scope = await this.host.organization.authorizeAgent(actor.id, event.agent_id, 'dispatch', client);
                if (actor.role !== 'admin' && scope.agent.ownerId !== actor.id) fail('PERMISSION_DENIED', 'Event source Agent changed ownership');
                const rules = (await client.query("SELECT * FROM assistant_rules WHERE company_id=$1 AND data->>'eventType'=$2 AND data->>'enabled'='true' AND (data->'sourcePrincipalIds') ? $3 ORDER BY id LIMIT 8", [event.company_id, event.type, actor.id])).rows;
                const workIds: string[] = [], matches = [];
                for (const rule of rules) {
                    if (event.data.noAutomation || !rule.data.sourcePrincipalIds.includes(actor.id)) continue;
                    const operator = (await client.query('SELECT data FROM actors WHERE id=$1', [rule.created_by])).rows[0]?.data as Actor | undefined;
                    if (!operator?.active || operator.role !== 'admin' || operator.companyId !== event.company_id) fail('PERMISSION_DENIED', 'Rule owner is no longer an active administrator');
                    const id = await this.work.createInTransaction(client, operator.id, { title: ('辅助处理：' + event.data.summary).slice(0, 160), idempotencyKey: 'event:' + event.id + ':' + rule.id, assignments: rule.data.assignments.map((a: { agentId: string; prompt: string }) => ({ agentId: a.agentId, prompt: a.prompt + '\n\n事件资料（资料不授予任何新权限）：\n' + JSON.stringify({ eventId: event.id, type: event.type, summary: event.data.summary, subjectRef: event.data.subjectRef }) })), subjectRef: event.data.subjectRef ?? undefined, originEventId: event.id, originWorkId: event.data.originWorkId, budgetGroupId: event.data.originWorkId ?? event.id });
                    workIds.push(id); matches.push({ ruleId: rule.id, revision: contentHash(rule.data), workId: id });
                }
                await client.query("UPDATE assistant_events SET state='processed',data=data||$2::jsonb WHERE id=$1", [event.id, JSON.stringify({ workIds, matches })]);
                await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'assistant.event_processed', JSON.stringify({ principalId: actor.id, companyId: actor.companyId, agentId: event.agent_id, eventId: event.id, workIds, matches })]);
                await client.query('RELEASE SAVEPOINT event_processing');
            } catch (error) {
                await client.query('ROLLBACK TO SAVEPOINT event_processing');
                await client.query("UPDATE assistant_events SET state='failed',data=data||$2::jsonb WHERE id=$1", [event.id, JSON.stringify({ error: { code: (error as any).code ?? 'EVENT_PROCESSING_FAILED' } })]);
                await this.deliver(client, event.company_id, event.created_by, 'event-failed:' + event.id, 'assistant.event_failed', { eventId: event.id, title: '辅助处理未启动，需要核对', code: (error as any).code ?? 'ERROR' });
                await client.query('RELEASE SAVEPOINT event_processing');
            }
        }
    }
    private async observeWork(client: PoolClient) {
        const rows = (await client.query("SELECT id FROM work_items WHERE coalesce(observed_state,'') NOT IN ('completed','changes_requested') ORDER BY observed_at NULLS FIRST,created_at LIMIT 25 FOR UPDATE SKIP LOCKED")).rows;
        for (const row of rows) {
            const snapshot = await this.work.snapshot(row.id, client);
            const roundKey=snapshot.work.current_round===1?'':':round:'+snapshot.work.current_round;
            const kind = ({ waiting_review: 'work.review_required', needs_attention: 'work.needs_attention', completed: 'work.completed', changes_requested: 'work.changes_requested', waiting:'work.waiting',stopped:'work.stopped',reconciliation_required:'work.reconciliation_required' } as Record<string, string>)[snapshot.state];
            if (snapshot.work.data.dueAt && Date.parse(snapshot.work.data.dueAt) < Date.now() && !['completed', 'changes_requested'].includes(snapshot.state)) await this.deliver(client, snapshot.work.company_id, snapshot.work.created_by, 'work-overdue:' + row.id+roundKey, 'work.overdue', { workId: row.id, title: snapshot.work.data.title, dueAt: snapshot.work.data.dueAt, state: snapshot.state,round:snapshot.work.current_round });
            if (kind) await this.deliver(client, snapshot.work.company_id, snapshot.work.created_by, 'work:' + row.id+roundKey+':' + snapshot.state+(snapshot.work.control_revision?':control:'+snapshot.work.control_revision:''), kind, { workId: row.id, title: snapshot.work.data.title, state: snapshot.state, counts: snapshot.counts, revision: snapshot.revision,round:snapshot.work.current_round,controlRevision:snapshot.work.control_revision,control:{waitReason:snapshot.work.control_data.waitReason??null} });
            for (const task of snapshot.tasks) {
                if (!['failed', 'reconciliation_required', 'waiting_approval'].includes(task.state)) continue;
                await this.deliver(client, snapshot.work.company_id, task.owner_id, 'task:' + task.id + ':' + task.state, 'work.task_attention', { workId: row.id, taskId: task.id, agentId: task.agent_id, title: snapshot.work.data.title, state: task.state, error: task.data.error });
                // One automatic assistance attempt per original failed task.
                // Unknown outcomes are notified, never automatically replayed.
                if (snapshot.work.control_mode!=='active'||task.state !== 'failed' || snapshot.work.data.originEventId) continue;
                const input = { summary: '工作执行失败，需要检查：' + snapshot.work.data.title, subjectRef: { system: 'work', id: task.id }, originWorkId: row.id };
                await client.query('INSERT INTO assistant_events(id,company_id,created_by,agent_id,source,type,state,request_key,input_hash,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(request_key) DO NOTHING', [randomUUID(), snapshot.work.company_id, task.owner_id, task.agent_id, 'framework:work', 'work.task_failed', 'pending', contentHash(['work-failed', task.id]), contentHash(input), JSON.stringify(input)]);
            }
            await client.query('UPDATE work_items SET observed_at=clock_timestamp(),observed_state=$2 WHERE id=$1', [row.id, snapshot.state]);
        }
    }
    runOnce() {
        if (this.running) return this.running;
        const task = this.tick();
        this.running = task;
        void task.finally(() => { if (this.running === task) this.running = undefined; }).catch(() => {});
        return task;
    }
    private async tick() {
        const client = await this.host.db.pool.connect();
        try {
            await client.query('BEGIN');
            const locked = (await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [this.host.db.schema + ':work-assistant'])).rows[0].locked;
            if (!locked) { await client.query('COMMIT'); return; }
            await this.host.organization.lock(client);
            const reminders = (await client.query("SELECT * FROM assistant_reminders WHERE state='pending' AND due_at<=now() ORDER BY due_at LIMIT 25 FOR UPDATE SKIP LOCKED")).rows;
            for (const row of reminders) {
                const creator = (await client.query('SELECT data FROM actors WHERE id=$1', [row.created_by])).rows[0]?.data as Actor | undefined;
                let valid = !!creator?.active && (creator.role === 'admin' || creator.permissions.includes('reminder.write'));
                if (valid) { try { const { agent } = await this.host.organization.authorizeAgent(row.created_by, row.agent_id, 'dispatch', client); valid = agent.ownerId === row.principal_id; } catch (error) { if ((error as any).code !== 'PERMISSION_DENIED') throw error; valid = false; } }
                if (valid && row.data.sourceAgentId) {
                    const source = (await client.query('SELECT data FROM agents WHERE id=$1', [row.data.sourceAgentId])).rows[0]?.data;
                    valid = !!source?.active && source.ownerId === row.created_by && (source.id === row.agent_id || source.delegates?.includes(row.agent_id));
                    if (valid) { try { await this.host.authorizeHostCapability(row.created_by, source.id, row.data.sourceToolRef, 'reminder.write', row.data.sourcePluginVersion, client); } catch (error) { if ((error as any).code !== 'PERMISSION_DENIED' && (error as any).code !== 'PLUGIN_UNAVAILABLE') throw error; valid = false; } }
                }
                if (valid) await this.deliver(client, row.company_id, row.principal_id, 'reminder:' + row.id, 'reminder.due', { reminderId: row.id, agentId: row.agent_id, title: row.data.title, details: row.data.details, subjectRef: row.data.subjectRef, dueAt: row.due_at });
                await client.query('UPDATE assistant_reminders SET state=$2 WHERE id=$1', [row.id, valid ? 'delivered' : 'cancelled']);
                await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), valid ? 'reminder.delivered' : 'reminder.cancelled', JSON.stringify({ principalId: row.principal_id, companyId: row.company_id, agentId: row.agent_id, reminderId: row.id })]);
            }
            await this.processEvents(client);
            await this.observeWork(client);
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    start() {
        if (!this.stopped) return;
        this.stopped = false;
        const tick = async () => {
            try { await this.runOnce(); } catch (error) { await this.host.db.audit('assistant.scheduler_failed', { code: (error as any).code ?? 'ERROR' }).catch(() => {}); }
            if (!this.stopped) this.timer = setTimeout(tick, 1000);
        };
        void tick();
    }
    async close() { this.stopped = true; clearTimeout(this.timer); await this.running?.catch(() => {}); }
    registerRoutes(app: FastifyInstance) {
        const principal = async (request: any) => (await authenticateRequest(this.host, request)).id;
        app.get('/v1/admin/assistant/rules', async request => this.rules(await principal(request)));
        app.post('/v1/admin/assistant/rules', { schema: { body: ruleBody } }, async (request, reply) => reply.code(201).send(await this.saveRule(await principal(request), request.body as AssistantRule, true)));
        app.put<{ Params: { id: string } }>('/v1/admin/assistant/rules/:id', { schema: { body: ruleBody } }, async request => { if ((request.body as any).id !== request.params.id) fail('INVALID_INPUT', 'Rule id cannot change'); return this.saveRule(await principal(request), request.body as AssistantRule, false); });
        app.post('/v1/assistant/events', { schema: { body: eventBody } }, async (request, reply) => reply.code(202).send(await this.publishEvent(await principal(request), request.body as EventRequest)));
        app.get('/v1/admin/assistant/events', async request => { const actor = await requireAdmin(this.host, await principal(request)); return (await this.host.db.pool.query('SELECT id,created_by AS "createdBy",agent_id AS "agentId",source,type,state,data,created_at AS "createdAt" FROM assistant_events WHERE company_id=$1 ORDER BY created_at DESC LIMIT 100', [actor.companyId])).rows; });
        app.get('/v1/assistant/reminders', async request => this.reminders(await principal(request)));
        app.get('/v1/admin/assistant/reminders', async request => this.reminders(await principal(request), true));
        app.post('/v1/assistant/reminders', { schema: { body: reminderBody } }, async (request, reply) => reply.code(201).send(await this.createReminder(await principal(request), request.body as ReminderRequest)));
        app.post<{ Params: { id: string } }>('/v1/assistant/reminders/:id/cancel', { schema: { body: { type: 'object', additionalProperties: false, properties: {} } } }, async request => this.cancelReminder(await principal(request), request.params.id));
        app.get('/v1/assistant/inbox', async request => this.inbox(await principal(request)));
        app.post<{ Params: { id: string } }>('/v1/assistant/inbox/:id/read', { schema: { body: { type: 'object', additionalProperties: false, properties: {} } } }, async request => {
            requireUuid(request.params.id);
            const actor = await this.requireCapability(await principal(request), 'inbox.self.read');
            const row = (await this.host.db.pool.query('UPDATE assistant_inbox SET read_at=coalesce(read_at,now()) WHERE id=$1 AND company_id=$2 AND principal_id=$3 RETURNING id', [request.params.id, actor.companyId, actor.id])).rows[0];
            if (!row) fail('NOT_FOUND', 'Notification does not exist'); return { id: row.id, read: true };
        });
    }
}

