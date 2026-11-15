import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { Framework } from './index.js';
import type { TaskQueue } from './tasks.js';
import type { Actor } from './types.js';
import { contentHash, requireUuid, zonedTimestamp } from './contracts.js';
import { fail } from './errors.js';
import { authenticateRequest } from './console-auth.js';
import { WorkContinuity, type WorkInput } from './work-continuity.js';
import { WorkControl, type WorkControlRequest, type WorkReconciliation } from './work-control.js';

export interface WorkRequest {
    title: string;
    idempotencyKey: string;
    assignments: Array<{ agentId: string; prompt: string }>;
    dueAt?: string;
    sourceAgentId?: string;
    sourceToolRef?: string;
    sourcePluginVersion?: string;
    originEventId?: string;
    originWorkId?: string;
    budgetGroupId?: string;
    subjectRef?: { system: string; id: string };
}
const assignment = { type: 'object', additionalProperties: false, required: ['agentId', 'prompt'], properties: { agentId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }, prompt: { type: 'string', minLength: 1, maxLength: 8000 } } };
export const workBody = { type: 'object', additionalProperties: false, required: ['title', 'idempotencyKey', 'assignments'], properties: {
    title: { type: 'string', minLength: 1, maxLength: 160 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 160 }, assignments: { type: 'array', minItems: 1, maxItems: 8, items: assignment }, dueAt: { type: 'string', maxLength: 40 }, subjectRef: { type: 'object', additionalProperties: false, required: ['system', 'id'], properties: { system: { type: 'string', minLength: 1, maxLength: 80 }, id: { type: 'string', minLength: 1, maxLength: 160 } } }
} };
export class WorkCoordinator {
    readonly continuity: WorkContinuity;
    readonly control: WorkControl;
    constructor(readonly host: Framework, readonly queue: TaskQueue) { host.coordination = this; this.control=new WorkControl(host,queue,this);this.continuity=new WorkContinuity(host,queue,this); }
    async createInTransaction(client: PoolClient, principalId: string, input: WorkRequest) {
        if (!input.title?.trim() || input.title.length > 160 || !input.idempotencyKey || input.idempotencyKey.length > 160 || !Array.isArray(input.assignments) || input.assignments.length < 1 || input.assignments.length > 8 || new Set(input.assignments.map(a => a.agentId)).size !== input.assignments.length) fail('INVALID_INPUT', 'Provide a title and one to eight distinct work Agents');
        if (input.dueAt) zonedTimestamp(input.dueAt);
        const actor = await this.host.db.get<Actor>('actors', principalId, client);
        if (!actor.active) fail('PERMISSION_DENIED', 'Work initiator is inactive');
        if (input.sourceAgentId) await this.host.authorizeHostCapability(actor.id, input.sourceAgentId, input.sourceToolRef!, 'work.dispatch', input.sourcePluginVersion, client);
        const key = contentHash(['work', actor.id, input.idempotencyKey]);
        const hash = contentHash(input);
        const prior = (await client.query('SELECT id,input_hash FROM work_items WHERE request_key=$1', [key])).rows[0];
        if (prior) { if (prior.input_hash !== hash) fail('CONFLICT', 'Work key reused with different input'); return prior.id as string; }
        const targets = [];
        for (const item of input.assignments) {
            if (typeof item.prompt !== 'string' || !item.prompt.trim() || item.prompt.length > 8000) fail('INVALID_INPUT', 'Invalid work instruction');
            const { agent } = await this.host.organization.authorizeAgent(actor.id, item.agentId, 'dispatch', client);
            await this.host.organization.authorizeAgent(actor.id, item.agentId, 'read', client);
            if (input.sourceAgentId) {
                const source = await this.host.authorize(actor.id, input.sourceAgentId, 'execute', client);
                if (source.agent.ownerId !== actor.id || (agent.id !== source.agent.id && !source.agent.delegates?.includes(agent.id))) fail('PERMISSION_DENIED', 'Work target is not granted to the initiating Agent');
            }
            targets.push({ item, agent });
        }
        const id = randomUUID();
        await client.query('INSERT INTO work_items(id,company_id,created_by,request_key,input_hash,data) VALUES($1,$2,$3,$4,$5,$6)', [id, actor.companyId, actor.id, key, hash, JSON.stringify({ title: input.title.trim(), dueAt: input.dueAt ?? null, sourceAgentId: input.sourceAgentId ?? null, sourceToolRef: input.sourceToolRef ?? null, sourcePluginVersion: input.sourcePluginVersion ?? null, subjectRef: input.subjectRef ?? null, originEventId: input.originEventId ?? null, originWorkId: input.originWorkId ?? null })]);
        for (const { item, agent } of targets) {
            const taskId = await this.queue.enqueueInTransaction(client, { principalId: actor.id, agentId: agent.id, prompt: item.prompt, idempotencyKey: 'work:' + id + ':' + agent.id, workId: id, budgetGroupId: input.budgetGroupId ?? id });
            await client.query('INSERT INTO work_assignments(work_id,task_id,agent_id,owner_id) VALUES($1,$2,$3,$4)', [id, taskId, agent.id, agent.ownerId]);
        }
        await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'work.dispatched', JSON.stringify({ principalId: actor.id, companyId: actor.companyId, workId: id, agents: targets.map(t => t.agent.id) })]);
        return id;
    }
    async create(principalId: string, input: WorkRequest) {
        const client = await this.host.db.pool.connect();
        let id: string;
        try { await client.query('BEGIN'); await this.host.organization.lock(client); id = await this.createInTransaction(client, principalId, input); await client.query('COMMIT'); }
        catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        return this.get(principalId, id);
    }
    async authorizeExecution(principalId: string, workId: string, targetId: string, client: Pick<PoolClient,'query'>=this.host.db.pool, taskId?:string) {
        const row = (await client.query('SELECT * FROM work_items WHERE id=$1', [workId])).rows[0];
        if (!row) fail('NOT_FOUND', 'Work does not exist');
        if(taskId){
            const task=(await client.query('SELECT data FROM tasks WHERE id=$1 AND agent_id=$2',[taskId,targetId])).rows[0];
            if(row.control_mode!=='active'||row.current_round!==(task?.data.workRound??1)||row.control_revision!==(task?.data.workControlRevision??0))fail('CANCELLED','Work control closed this task');
            if(task?.data.workInputId){
                if(task.data.workRound!==row.current_round||task.data.workControlRevision!==row.control_revision)fail('CONFLICT','Work execution belongs to an older round');
                const input=(await client.query('SELECT data FROM work_inputs WHERE id=$1 AND work_id=$2',[task.data.workInputId,workId])).rows[0];
                const actor=await this.host.db.get<Actor>('actors',principalId,client),agent=await this.host.db.get<import('./types.js').Agent>('agents',targetId,client);
                const accepted=input?.data.authorization;
                if(!accepted||accepted.initiatedBy!==actor.id||accepted.actorRevision!==contentHash(actor)||accepted.agents.find((a:any)=>a.agentId===targetId)?.revision!==contentHash(agent))fail('PERMISSION_DENIED','Accepted work authorization or capability binding changed');
            }
        }
        if (row.data.sourceAgentId) {
            const { agent } = await this.host.authorizeHostCapability(principalId, row.data.sourceAgentId, row.data.sourceToolRef, 'work.dispatch', row.data.sourcePluginVersion,client);
            if (agent.ownerId !== principalId || (agent.id !== targetId && !agent.delegates?.includes(targetId))) fail('PERMISSION_DENIED', 'Work delegation grant was revoked');
        }
    }
    async snapshot(id: string, client: Pick<PoolClient, 'query'> = this.host.db.pool) {
        requireUuid(id);
        const work = (await client.query('SELECT * FROM work_items WHERE id=$1', [id])).rows[0];
        if (!work) fail('NOT_FOUND', 'Work does not exist');
        const tasks = (await client.query(work.current_round===1?'SELECT a.agent_id,a.owner_id,t.id,t.state,t.data,t.updated_at FROM work_assignments a JOIN tasks t ON t.id=a.task_id WHERE a.work_id=$1 ORDER BY a.agent_id':'SELECT a.agent_id,a.owner_id,t.id,t.state,t.data,t.updated_at FROM work_round_assignments a JOIN tasks t ON t.id=a.task_id WHERE a.work_id=$1 AND a.round=$2 ORDER BY a.agent_id',work.current_round===1?[id]:[id,work.current_round])).rows;
        const revision = contentHash({ id, data: work.data, ...(work.control_revision?{controlRevision:work.control_revision,currentRound:work.current_round,...(work.control_mode!=='active'||Object.keys(work.control_data).length?{controlMode:work.control_mode,control:work.control_data}:{})}:{}), tasks: tasks.map(t => ({ id: t.id, state: t.state, data: t.data })) });
        const review = (await client.query('SELECT revision,reviewed_by,decision,reason,created_at FROM work_reviews WHERE work_id=$1', [id])).rows[0];
        const counts: Record<string, number> = {};
        for (const task of tasks) counts[task.state] = (counts[task.state] ?? 0) + 1;
        let state = 'queued';
        if (tasks.every(t => t.state === 'succeeded')) state = review?.revision === revision ? review.decision === 'approve' ? 'completed' : 'changes_requested' : 'waiting_review';
        else if (tasks.some(t => ['failed', 'reconciliation_required', 'waiting_approval', 'cancelled'].includes(t.state))) state = 'needs_attention';
        else if (tasks.some(t => t.state !== 'queued')) state = 'running';
        if(work.control_mode!=='active')state=work.control_mode;
        return { work, tasks, revision, review: review?.revision === revision ? review : null, counts, state };
    }
    async get(principalId: string, id: string) {
        const actor = await this.host.db.get<Actor>('actors', principalId);
        const snapshot = await this.snapshot(id);
        if (!actor.active || snapshot.work.company_id !== actor.companyId) fail('PERMISSION_DENIED', 'Work belongs to another company');
        const visible = [];
        for (const row of snapshot.tasks) {
            try {
                const { agent } = await this.host.organization.authorizeAgent(actor.id, row.agent_id, 'read');
                const owner = await this.host.db.get<Actor>('actors', agent.ownerId);
                visible.push({ ...row, agentName: agent.displayName ?? '岗位助手', ownerName: owner.displayName ?? '负责同事' });
            }
            catch (error) { if ((error as any).code !== 'PERMISSION_DENIED') throw error; }
        }
        if (!visible.length) fail('PERMISSION_DENIED', 'No assigned work is currently visible');
        let canControl=false;
        try{await this.control.authorize(this.host.db.pool,principalId,id);canControl=true;}catch(error){if((error as any).code!=='PERMISSION_DENIED')throw error;}
        let canReconcile=false;
        try{await this.control.authorize(this.host.db.pool,principalId,id,true);canReconcile=true;}catch(error){if((error as any).code!=='PERMISSION_DENIED')throw error;}
        let canReview = visible.length === snapshot.tasks.length && snapshot.state === 'waiting_review';
        for (const row of snapshot.tasks) if (canReview) {
            if (actor.role !== 'admin' && (row.owner_id === actor.id || !actor.permissions.includes('team.review'))) canReview = false;
            else if (!await this.host.organization.permits(actor.id, row.owner_id, 'review')) canReview = false;
        }
        return { id, title: snapshot.work.data.title, createdBy: snapshot.work.created_by, dueAt: snapshot.work.data.dueAt, subjectRef: snapshot.work.data.subjectRef, state: snapshot.state, counts: snapshot.counts, revision: snapshot.revision, currentRound:snapshot.work.current_round, controlRevision:snapshot.work.control_revision,controlMode:snapshot.work.control_mode,control:(canControl||canReconcile)?snapshot.work.control_data:{waitReason:snapshot.work.control_data.waitReason??null},controlRestricted:!(canControl||canReconcile),canControl,canReconcile, review: snapshot.review, canReview, restrictedAssignments: snapshot.tasks.length - visible.length, assignments: visible.map(row => ({ taskId: row.id, agentId: row.agent_id, ownerId: row.owner_id, agentName: row.agentName, ownerName: row.ownerName, state: row.state, summary: String(row.data.output ?? '').slice(0, 1000), runId: row.data.runId, error: row.data.error, updatedAt: row.updated_at })), createdAt: snapshot.work.created_at };
    }
    async list(principalId: string) {
        const actor = await this.host.db.get<Actor>('actors', principalId);
        const rows = (await this.host.db.pool.query('SELECT id FROM work_items WHERE company_id=$1 ORDER BY created_at DESC LIMIT 100', [actor.companyId])).rows;
        const result = [];
        for (const row of rows) { try { result.push(await this.get(principalId, row.id)); } catch (error) { if ((error as any).code !== 'PERMISSION_DENIED') throw error; } }
        return result;
    }
    async review(principalId: string, id: string, input: { revision: string; decision: 'approve' | 'reject'; reason: string }) {
        requireUuid(id);
        if (!input.reason?.trim() || input.reason.length > 1000 || !['approve', 'reject'].includes(input.decision)) fail('INVALID_INPUT', 'Explicit review decision and reason are required');
        const client = await this.host.db.pool.connect();
        try {
            await client.query('BEGIN'); await this.host.organization.lock(client);
            await client.query('SELECT id FROM work_items WHERE id=$1 FOR UPDATE', [id]);
            const snapshot = await this.snapshot(id, client);
            const actor = await this.host.db.get<Actor>('actors', principalId, client);
            if (!actor.active || actor.companyId !== snapshot.work.company_id) fail('PERMISSION_DENIED', 'Review is outside company scope');
            for (const row of snapshot.tasks) {
                if (actor.role !== 'admin' && (row.owner_id === actor.id || !actor.permissions.includes('team.review'))) fail('PERMISSION_DENIED', 'A separate authorized human reviewer is required');
                await this.host.organization.authorizeAgent(actor.id, row.agent_id, 'review', client);
            }
            if (snapshot.revision !== input.revision) fail('CONFLICT', 'Work results changed; read them before reviewing');
            if (snapshot.state !== 'waiting_review' && snapshot.state !== 'changes_requested' && snapshot.state !== 'completed') fail('CONFLICT', 'All tasks must finish successfully before review');
            if (snapshot.review && (snapshot.review.reviewed_by !== actor.id || snapshot.review.decision !== input.decision || snapshot.review.reason !== input.reason.trim())) fail('CONFLICT', 'These results already have a different review decision');
            if (!snapshot.review) {
                await client.query('INSERT INTO work_review_history(work_id,round,revision,reviewed_by,decision,reason) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[id,snapshot.work.current_round,snapshot.revision,actor.id,input.decision,input.reason.trim()]);
                await client.query('INSERT INTO work_reviews(work_id,revision,reviewed_by,decision,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT(work_id) DO UPDATE SET revision=EXCLUDED.revision,reviewed_by=EXCLUDED.reviewed_by,decision=EXCLUDED.decision,reason=EXCLUDED.reason,created_at=now()', [id, snapshot.revision, actor.id, input.decision, input.reason.trim()]);
                await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'work.reviewed', JSON.stringify({ principalId: actor.id, companyId: actor.companyId, workId: id, decision: input.decision, revision: snapshot.revision })]);
            }
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        return this.get(principalId, id);
    }
    registerRoutes(app: FastifyInstance) {
        const principal = async (request: any) => (await authenticateRequest(this.host, request)).id;
        app.get('/v1/work', async request => this.list(await principal(request)));
        app.post('/v1/work', { schema: { body: workBody } }, async (request, reply) => reply.code(202).send(await this.create(await principal(request), request.body as WorkRequest)));
        app.get<{ Params: { id: string } }>('/v1/work/:id', async request => this.get(await principal(request), request.params.id));
        app.get<{Params:{id:string}}>('/v1/work/:id/control',async request=>this.control.status(await principal(request),request.params.id));
        app.get<{Params:{id:string;actionId:string}}>('/v1/work/:id/actions/:actionId',async request=>this.control.action(await principal(request),request.params.id,request.params.actionId));
        app.post<{Params:{id:string};Body:WorkReconciliation}>('/v1/work/:id/reconcile',{schema:{body:{type:'object',additionalProperties:false,required:['revision','idempotencyKey','reason','evidenceRefs'],properties:{revision:{type:'string',pattern:'^[a-f0-9]{64}$'},idempotencyKey:{type:'string',minLength:1,maxLength:160},reason:{type:'string',minLength:1,maxLength:1000},evidenceRefs:{type:'array',minItems:1,maxItems:16,items:{type:'string',minLength:1,maxLength:240}},actions:{type:'array',maxItems:16,items:{type:'object',additionalProperties:false,required:['actionId','outcome'],properties:{actionId:{type:'string',format:'uuid'},outcome:{enum:['succeeded','not_executed']},value:{}}}},tasks:{type:'array',maxItems:16,items:{type:'object',additionalProperties:false,required:['taskId','outcome'],properties:{taskId:{type:'string',format:'uuid'},outcome:{const:'closed'}}}}}}}},async request=>this.control.reconcile(await principal(request),request.params.id,request.body));
        app.post<{Params:{id:string};Body:WorkControlRequest}>('/v1/work/:id/control',{schema:{body:{type:'object',additionalProperties:false,required:['revision','idempotencyKey','action','reason'],properties:{revision:{type:'string',pattern:'^[a-f0-9]{64}$'},idempotencyKey:{type:'string',minLength:1,maxLength:160},action:{enum:['stop','wait','resume']},reason:{type:'string',minLength:1,maxLength:1000},waitReason:{enum:['human_decision','dependency','environment_unavailable']},question:{type:'string',maxLength:1000},assignments:{type:'array',minItems:1,maxItems:8,items:assignment}}}}},async(request,reply)=>reply.code(202).send(await this.control.command(await principal(request),request.params.id,request.body)));
        app.get<{Params:{id:string}}>('/v1/work/:id/history',async request=>this.continuity.history(await principal(request),request.params.id));
        app.get<{Params:{id:string;inputId:string}}>('/v1/work/:id/inputs/:inputId',async request=>this.continuity.input(await principal(request),request.params.id,request.params.inputId));
        app.post<{Params:{id:string};Body:WorkInput}>('/v1/work/:id/inputs',{schema:{body:{type:'object',additionalProperties:false,required:['revision','idempotencyKey','assignments'],properties:{revision:{type:'string',pattern:'^[a-f0-9]{64}$'},idempotencyKey:{type:'string',minLength:1,maxLength:160},assignments:{type:'array',minItems:1,maxItems:8,items:assignment}}}}},async(request,reply)=>reply.code(202).send(await this.continuity.append(await principal(request),request.params.id,request.body,{kind:'http'})));
        app.post<{ Params: { id: string }; Body: { revision: string; decision: 'approve' | 'reject'; reason: string } }>('/v1/work/:id/review', { schema: { body: { type: 'object', additionalProperties: false, required: ['revision', 'decision', 'reason'], properties: { revision: { type: 'string', pattern: '^[a-f0-9]{64}$' }, decision: { enum: ['approve', 'reject'] }, reason: { type: 'string', minLength: 1, maxLength: 1000 } } } } }, async request => this.review(await principal(request), request.params.id, request.body));
    }
}

