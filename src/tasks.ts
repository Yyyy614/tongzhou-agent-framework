import type { Framework } from './index.js';
import { authenticateRequest } from './console-auth.js';
import { fail, AdmissionBusyError, FrameworkError } from './errors.js';
import { PgBoss } from 'pg-boss';
import { createHash, randomUUID } from 'node:crypto';
import { BotGateway } from './bot.js';
import type { PoolClient } from 'pg';
import { WorkCoordinator } from './work.js';
import { WorkAssistant } from './assistant.js';
import{EntryConnections}from'./entry-connections.js';
export interface TaskRequest {
    principalId: string;
    agentId: string;
    prompt: string;
    idempotencyKey: string;
    parentTaskId?: string;
    taskId?: string;
    budgetGroupId?: string;
    initiatingPrincipalId?: string;
    workId?: string;
    workRound?:number;
    workInputId?:string;
    workControlRevision?:number;
}
export interface TaskExecutor {
    assessEvent?(input: import('./event-routing.js').EventAssessment): Promise<import('./event-routing.js').EventDecision>;
    stopWork?(workId:string):Promise<void>;
    run(request: TaskRequest): Promise<{
        id: string;
        state: string;
        output?: string;
        report?: import('./work-results.js').StructuredReport;
    }>;
}
export class TaskQueue {
    private boss: PgBoss;
    private opened = false;
    constructor(readonly host: Framework, readonly executor: TaskExecutor, readonly concurrency = 3) { if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) fail('INVALID_INPUT', 'Worker concurrency must be between one and sixteen'); this.boss = new PgBoss({ schema: host.db.schema + '_queue', db: { executeSql: (sql, values) => host.db.pool.query(sql, values) } }); this.boss.on('error', error => { void host.db.audit('queue.error', { code: (error as any).code ?? 'QUEUE_ERROR' }).catch(() => { }); }); }
    async open() { await this.boss.start(); await this.boss.createQueue('agent-task', { retryLimit: 0, expireInSeconds: 360, heartbeatSeconds: 30 }); this.opened = true; }
    async enqueueInTransaction(client: PoolClient, request: TaskRequest) {
        const { agent } = await this.host.organization.authorizeAgent(request.principalId, request.agentId, 'dispatch', client);
        if (!request.prompt?.trim() || request.prompt.length > 8000 || !request.idempotencyKey || request.idempotencyKey.length > 160) fail('INVALID_INPUT', 'Invalid task');
        const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
        const key = hash([request.principalId, request.agentId, request.idempotencyKey]);
        const inputHash = hash(request.workId ? [request.prompt, request.parentTaskId ?? null, request.workId] : [request.prompt, request.parentTaskId ?? null]);
        const prior = (await client.query('SELECT * FROM tasks WHERE request_key=$1', [key])).rows[0];
        if (prior) { if (prior.input_hash !== inputHash) fail('CONFLICT', 'Task key reused with changed input'); return prior.id as string; }
        if (request.parentTaskId) {
            const parent = (await client.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [request.parentTaskId])).rows[0];
            if (!parent || parent.principal_id !== request.principalId || parent.parent_id) fail('PERMISSION_DENIED', 'Delegation depth or parent scope is invalid');
            if (parent.data.workId) fail('BUDGET_EXCEEDED', 'A work assignment cannot start legacy child tasks');
            const count = (await client.query('SELECT count(*)::int AS n FROM tasks WHERE parent_id=$1', [parent.id])).rows[0].n;
            if (count >= 2) fail('BUDGET_EXCEEDED', 'Parent already has two child tasks');
        }
        const id = randomUUID();
        const data = { resultFormat:'references-v1',prompt: request.prompt, idempotencyKey: 'task:' + id, executionPrincipalId: agent.ownerId, ...(request.workId ? { workId: request.workId, budgetGroupId: request.budgetGroupId ?? request.workId,workRound:request.workRound,workInputId:request.workInputId,workControlRevision:request.workControlRevision } : {}) };
        await client.query('INSERT INTO tasks(id,agent_id,principal_id,state,request_key,input_hash,data,parent_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, agent.id, request.principalId, 'queued', key, inputHash, JSON.stringify(data), request.parentTaskId ?? null]);
        const jobId = await this.boss.send('agent-task', { taskId: id }, { id, group: { id: agent.id }, retryLimit: 0, db: { executeSql: (sql, values) => client.query(sql, values) } });
        if (!jobId) fail('CONFLICT', 'Task job was not accepted');
        await client.query('UPDATE tasks SET job_id=$2 WHERE id=$1', [id, jobId]);
        await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'task.queued', JSON.stringify({ principalId: request.principalId, agentId: agent.id, taskId: id, parentTaskId: request.parentTaskId, workId: request.workId })]);
        return id;
    }
    async submit(request: TaskRequest) {
        const client = await this.host.db.pool.connect();
        let id: string;
        try { await client.query('BEGIN'); await this.host.organization.lock(client); id = await this.enqueueInTransaction(client, request); await client.query('COMMIT'); }
        catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        return this.get(id, request.principalId);
    }
    async startWorker() {
        this.host.events.start();
        await this.boss.work<{
            taskId: string;
        }>('agent-task', { localConcurrency: this.concurrency, groupConcurrency: 1, pollingIntervalSeconds: 0.5, batchSize: 1 }, async (jobs) => {
            for (const job of jobs) {
                const row = (await this.host.db.pool.query("UPDATE tasks SET state='running',updated_at=now() WHERE id=$1 AND state='queued' RETURNING *", [job.data.taskId])).rows[0];
                if (!row)
                    continue;
                try {
                    const result = await this.executeAdmitted({ principalId: row.data.executionPrincipalId, initiatingPrincipalId: row.principal_id, agentId: row.agent_id, prompt: row.data.prompt, idempotencyKey: row.data.idempotencyKey, taskId: row.id, workId: row.data.workId,workRound:row.data.workRound,workInputId:row.data.workInputId,workControlRevision:row.data.workControlRevision, budgetGroupId: row.data.budgetGroupId ?? row.parent_id ?? row.id });
                    await this.host.db.pool.query("UPDATE tasks SET data=data||$2::jsonb WHERE id=$1 AND state='running'", [row.id, JSON.stringify({ resultFormat:'references-v1',runId: result.id, output: result.output ?? '' })]);
                    await this.host.results.capture(row, result);
                    await this.host.db.pool.query("UPDATE tasks SET state=$2,data=data||$3::jsonb,updated_at=now() WHERE id=$1 AND state='running'", [row.id, result.state, JSON.stringify({ runId: result.id, output: result.output ?? '' })]);
                }
                catch (error) {
                    const code = (error as any).code ?? 'ERROR';
                    const state = code === 'CANCELLED' ? 'cancelled' : code === 'APPROVAL_REQUIRED' ? 'waiting_approval' : ['RESULT_UNKNOWN', 'TIMEOUT', 'CONFLICT'].includes(code) ? 'reconciliation_required' : 'failed';
                    await this.host.db.pool.query("UPDATE tasks SET state=$2,data=data||$3::jsonb,updated_at=now() WHERE id=$1 AND state='running'", [row.id, state, JSON.stringify({ error: { code } })]);
                    await this.host.db.audit('task.failed', { principalId: row.principal_id, agentId: row.agent_id, taskId: row.id, code });
                }
                finally{if(row.data.workId)await this.host.coordination?.control.settle(row.data.workId);}
            }
        });
    }
    async get(id: string, principalId: string) {
        if (!/^[0-9a-f-]{36}$/u.test(id))
            fail('INVALID_INPUT', 'Invalid task id');
        const row = (await this.host.db.pool.query('SELECT * FROM tasks WHERE id=$1', [id])).rows[0];
        if (!row)
            fail('NOT_FOUND', 'Task does not exist');
        if (row.data.workId) await this.host.organization.authorizeAgent(principalId, row.agent_id, 'read');
        else if (row.principal_id === principalId) {
            const actor = await this.host.db.get<import('./types.js').Actor>('actors', principalId);
            const agent = await this.host.db.get<import('./types.js').Agent>('agents', row.agent_id);
            if (!actor.active || actor.companyId !== agent.companyId) fail('PERMISSION_DENIED', 'Task receipt belongs to another company or inactive account');
        } else await this.host.authorize(principalId, row.agent_id, 'read');
        const result = await this.host.results.view(principalId, id);
        const executionOwner=row.data.executionPrincipalId??(await this.host.db.get<import('./types.js').Agent>('agents',row.agent_id)).ownerId;
        return { id: row.id, agentId: row.agent_id, principalId: row.principal_id, initiatingPrincipalId: row.principal_id, executionPrincipalId: row.data.executionPrincipalId, workId: row.data.workId,workRound:row.data.workRound,workInputId:row.data.workInputId, state: row.state, parentTaskId: row.parent_id, runId: row.data.runId, output: result?.processAvailable||!result&&(executionOwner===principalId) ? row.data.output : undefined, result,resultPending:!!row.data.resultFormat&&!result, error: row.data.error, createdAt: row.created_at, updatedAt: row.updated_at };
    }
    private async executeAdmitted(request: TaskRequest) {
        const deadline = Date.now() + 30000;
        let logged = false;
        while (true) {
            try {
                const initiator = request.initiatingPrincipalId ?? request.principalId;
                const { agent } = await this.host.organization.authorizeAgent(initiator, request.agentId, 'dispatch');
                if (agent.ownerId !== request.principalId) fail('PERMISSION_DENIED', 'Task ownership changed before execution');
                if (request.workId) await this.host.coordination?.authorizeExecution(initiator, request.workId, request.agentId,this.host.db.pool,request.taskId);
                await this.host.coordination?.control.guard(request);
                return await this.executor.run(request);
            }
            catch (error) {
                // Class identity is trusted host evidence, never a remote error code.
                // Retry admission only; once execution starts, uncertain work is not replayed.
                if (!(error instanceof AdmissionBusyError)) throw error;
                if (!this.opened) throw new FrameworkError('UNAVAILABLE', 'Task processing stopped before admission');
                if (Date.now() >= deadline) throw new FrameworkError('ADMISSION_TIMEOUT', 'Agent stayed busy; this task did not execute');
                if (!logged) { await this.host.db.audit('task.waiting_for_agent', { principalId: request.initiatingPrincipalId ?? request.principalId, agentId: request.agentId, taskId: request.taskId }); logged = true; }
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        }
    }
    async summaries(agentId: string, principalId: string) {
        await this.host.organization.authorizeAgent(principalId, agentId, 'read');
        const rows = (await this.host.db.pool.query("SELECT id,state,CASE WHEN data ? 'resultFormat' THEN '执行记录待整理或核实' WHEN data->>'executionPrincipalId'=$2 THEN left(data->>'output',2000) ELSE '执行状态已记录' END AS summary,data->>'runId' AS \"runId\",data->'error' AS error,updated_at FROM tasks WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 30", [agentId,principalId])).rows;
        for (const row of rows) { const result = await this.host.results.view(principalId, row.id); if (result) { row.summary = result.summary; row.result = result; } }
        return rows;
    }
    registerRoutes(app: import('fastify').FastifyInstance) {
        app.get<{ Params: { id: string } }>('/v1/tasks/:id/result', async request => { const actor = await authenticateRequest(this.host, request); return this.host.results.view(actor.id, request.params.id); });
        const principal = async (request: any) => (await authenticateRequest(this.host, request)).id;
        const bot = new BotGateway(this.host, this);
        const work = new WorkCoordinator(this.host, this);
        this.host.events.bind(this);
        work.registerRoutes(app);
        if(this.host.options.entries)new EntryConnections(this.host,work).registerRoutes(app);
        new WorkAssistant(this.host, work).registerRoutes(app);
        app.post('/v1/bot/messages', { schema: { body: { type: 'object', additionalProperties: false, required: ['agentId', 'conversationId', 'messageId', 'text'], properties: { agentId: { type: 'string', minLength: 1, maxLength: 64 }, conversationId: { type: 'string', minLength: 1, maxLength: 160 }, messageId: { type: 'string', minLength: 1, maxLength: 160 }, text: { type: 'string', minLength: 1, maxLength: 8000 },workId:{type:'string',format:'uuid'},revision:{type:'string',pattern:'^[a-f0-9]{64}$'} } } } }, async (request, reply) => reply.code(202).send(await bot.accept({ principalId: await principal(request), channelId: 'local-bot' }, request.body as import('./bot.js').BotMessage)));
        app.post('/v1/tasks', { schema: { body: { type: 'object', additionalProperties: false, required: ['agentId', 'prompt', 'idempotencyKey'], properties: { agentId: { type: 'string' }, prompt: { type: 'string', minLength: 1, maxLength: 8000 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 160 }, parentTaskId: { type: 'string', format: 'uuid' } } } } }, async (request, reply) => { const task = await this.submit({ ...request.body as any, principalId: await principal(request) }); return reply.code(202).send(task); });
        app.get<{
            Params: {
                id: string;
            };
        }>('/v1/tasks/:id', async (request) => this.get(request.params.id, await principal(request)));
        app.get<{
            Params: {
                agentId: string;
            };
        }>('/v1/agents/:agentId/task-summaries', async (request) => this.summaries(request.params.agentId, await principal(request)));
    }
    async stopWork(workId:string){await this.executor.stopWork?.(workId);}
    async recoverInterrupted() {
        // Startup under HostLease only. Preserve interrupted task facts, but release orphaned
        // queue slots; cancelling a queue envelope is not confirmation of an external effect.
        const client=await this.host.db.pool.connect();let count;
        try{
            await client.query('BEGIN');
            count=(await client.query("UPDATE tasks SET state='reconciliation_required',updated_at=now() WHERE state='running'")).rowCount;
            const jobs=(await client.query("SELECT job_id FROM tasks WHERE state='reconciliation_required' AND job_id IS NOT NULL")).rows.map(r=>r.job_id);
            if(jobs.length)await this.boss.cancel('agent-task',jobs,{db:{executeSql:(sql,values)=>client.query(sql,values)}});
            await client.query('COMMIT');
        }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
        await this.host.coordination?.control.recoverInterrupted();return count;
    }
    async close() {
        await this.host.events.close();
        if (this.opened) {
            this.opened = false;
            await this.boss.stop({ graceful: true, timeout: 150000 });
        }
    }
}
