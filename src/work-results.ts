import { randomUUID } from 'node:crypto';
import type { Framework } from './index.js';
import type { ResourceRef } from './resources.js';
import { fail, FrameworkError } from './errors.js';
import { requireUuid, contentHash } from './contracts.js';

export interface ReportedFact { text: string; refs: ResourceRef[]; }
export interface StructuredReport { facts: ReportedFact[]; artifacts: ResourceRef[]; issues: Array<string | ReportedFact>; }
const refSchema = { type: 'object', additionalProperties: false, required: ['id', 'version'], properties: { id: { type: 'string', maxLength: 36 }, version: { type: 'integer', minimum: 1 } } };
const factSchema = { type: 'object', additionalProperties: false, required: ['text', 'refs'], properties: { text: { type: 'string', maxLength: 500 }, refs: { type: 'array', maxItems: 8, items: refSchema } } };
export const reportSchema = { type: 'object', additionalProperties: false, required: ['facts', 'artifacts', 'issues'], properties: { facts: { type: 'array', maxItems: 16, items: factSchema }, artifacts: { type: 'array', maxItems: 16, items: refSchema }, issues: { type: 'array', maxItems: 16, items: { anyOf: [{ type: 'string', maxLength: 500 }, factSchema] } } } };

/** Host control facts, agent claims and private process output are separate records. */
export class WorkResults {
    constructor(readonly host: Framework) {}
    async open() {
        await this.host.db.pool.query('CREATE TABLE IF NOT EXISTS task_results(task_id uuid PRIMARY KEY REFERENCES tasks(id),company_id text NOT NULL,owner_id text NOT NULL,agent_id text NOT NULL,run_id text NOT NULL,control jsonb NOT NULL,reported jsonb NOT NULL,process_ref jsonb NOT NULL,input_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());ALTER TABLE task_results ADD COLUMN IF NOT EXISTS dependencies jsonb');
    }
    async capture(task: any, result: { id: string; state: string; output?: string; report?: StructuredReport }) {
        try {
            const owner = await this.host.db.get<import('./types.js').Actor>('actors', task.data.executionPrincipalId);
            const prior = (await this.host.db.pool.query('SELECT input_hash FROM task_results WHERE task_id=$1', [task.id])).rows[0], inputHash = contentHash(result);
            if (prior) { if (prior.input_hash !== inputHash) fail('CONFLICT', 'Task result is immutable'); return; }
            const valid = !result.report || this.host.registry.ajv.validate(reportSchema, result.report);
            const reported: StructuredReport = valid && result.report ? result.report : { facts: [], artifacts: [], issues: result.report ? ['报告格式需核实，宿主没有采纳其中的状态或权限声明。'] : [] };
            for (const ref of [...reported.artifacts, ...reported.facts.flatMap(f => f.refs), ...reported.issues.flatMap(i => typeof i === 'string' ? [] : i.refs)]) await this.host.resources.read(owner.id, ref.id, ref.version);
            const dependencies=await this.host.provenance.snapshot(result.id)??[{kind:'unknown' as const,id:result.id,ownerId:owner.id,companyId:owner.companyId}];
            const raw = result.output ?? '', process = await this.host.resources.create(owner.id, { title: '工作过程与完整回复', kind: 'artifact', domain: 'work-process', body: raw.slice(0, 128000), access: { scope: 'personal', readerIds: [] }, idempotencyKey: 'task-output:' + task.id + ':' + result.id, sourceRefs: ['task:' + task.id, 'run:' + result.id] },{sources:dependencies,retentionOnly:true});
            const effects = (await this.host.db.pool.query("SELECT state,count(*)::int AS count FROM invocations WHERE receipt->>'runId'=$1 GROUP BY state", [result.id])).rows;
            const control = { taskId: task.id, workId: task.data.workId ?? null, round: task.data.workRound ?? 1, agentId: task.agent_id, runId: result.id, toolOutcomes: effects, processTruncated: raw.length > 128000, resultRequiresReview: true, invalidReport: !valid };
            await this.host.db.pool.query('INSERT INTO task_results(task_id,company_id,owner_id,agent_id,run_id,control,reported,process_ref,input_hash,dependencies) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [task.id, owner.companyId, owner.id, task.agent_id, result.id, JSON.stringify(control), JSON.stringify(reported), JSON.stringify({ id: process.id, version: process.version }), inputHash,JSON.stringify(dependencies)]);
            await this.host.db.audit('work.result_recorded', { companyId: owner.companyId, principalId: owner.id, agentId: task.agent_id, taskId: task.id, runId: result.id, facts: reported.facts.length, artifacts: reported.artifacts.length });
            try{await this.host.workMemory.recordResult(task,result.id,{id:process.id,version:process.version});}
            catch{await this.host.db.audit('work.memory_update_deferred',{principalId:owner.id,agentId:task.agent_id,workId:task.data.workId,runId:result.id}).catch(()=>{});}
        } catch (error) { throw new FrameworkError('RESULT_UNKNOWN', 'Result persistence or its sources require reconciliation; execution was not replayed', { causeCode: (error as any).code ?? 'PERSISTENCE_ERROR', taskId: task.id, runId: result.id }); }
    }
    async view(principalId: string, taskId: string) {
        requireUuid(taskId);
        const task = (await this.host.db.pool.query('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0];
        if (!task) fail('NOT_FOUND', 'Task result is unavailable');
        if(task.principal_id===principalId&&!task.data.workId){const actor=await this.host.db.get<import('./types.js').Actor>('actors',principalId),agent=await this.host.db.get<import('./types.js').Agent>('agents',task.agent_id);if(!actor.active||actor.companyId!==agent.companyId)fail('PERMISSION_DENIED','Task receipt belongs to another company or inactive account');}
        else await this.host.organization.authorizeAgent(principalId, task.agent_id, 'read');
        const row = (await this.host.db.pool.query('SELECT * FROM task_results WHERE task_id=$1', [taskId])).rows[0];
        if (!row) return null;
        const own = row.owner_id === principalId, facts: any[] = [], artifacts: any[] = [], issues: string[] = [];
        const dependencies=await this.host.provenance.status(principalId,row.dependencies);
        const reportVisible=row.dependencies?dependencies.visible:own;
        const visible = async (ref: ResourceRef) => {
            try { const source = await this.host.resources.read(principalId, ref.id, ref.version); return { id: source.id, version: source.version, digest: source.digest, title: source.title, freshness: source.freshness }; }
            catch (error) { if ((error as any).code === 'NOT_FOUND') return null; throw error; }
        };
        const fact = async (value: ReportedFact) => {
            if (!own && !value.refs.length) return null;
            const refs = await Promise.all(value.refs.map(visible)); if (refs.some(r => !r)) return null;
            return { text: value.text, refs, origin: 'agent_reported', freshness: refs.some(r => r!.freshness !== 'current') ? 'stale' : 'current' };
        };
        if(reportVisible){for (const value of row.reported.facts) { const item = await fact(value); if (item) facts.push(item); }
        for (const value of row.reported.artifacts) { const item = await visible(value); if (item) artifacts.push(item); }
        for (const value of row.reported.issues) { if (typeof value === 'string') { if (own) issues.push(value); } else { const item = await fact(value); if (item) issues.push(item.text); } }}
        const process = await visible(row.process_ref), state = task.state;
        const summary = [state === 'succeeded' ? '执行已结束，等待人工核对' : ({ running: '执行中', failed: '执行失败', reconciliation_required: '执行结果待核实', waiting_approval: '等待审批', cancelled: '已取消' } as Record<string, string>)[state] ?? '工作已登记', ...facts.filter(f => f.freshness === 'current').map(f => f.text), ...(artifacts.length ? ['可查看成果 ' + artifacts.length + ' 项'] : []), ...(issues.length ? ['需关注 ' + issues.length + ' 项'] : [])].join('；');
        return { taskId, control: { ...row.control, state }, facts, artifacts, issues, coverage: 'authorized-results', summary, processAvailable: !!process, ...(process ? { processRef: row.process_ref } : {}), createdAt: row.created_at };
    }
}
