import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Framework} from './index.js';
import type {TaskQueue} from './tasks.js';
import type {WorkCoordinator} from './work.js';
import type {Actor} from './types.js';
import {contentHash,requireUuid} from './contracts.js';
import {fail} from './errors.js';
import type{WorkControlRequest}from'./work-control.js';

export interface WorkInput {
    revision:string;
    idempotencyKey:string;
    assignments:Array<{agentId:string;prompt:string}>;
}
export type WorkEntry={kind:'http'}|{kind:'control_resume'}|{kind:'bot';channelId:string;conversationId:string;messageId:string}|{kind:'event';sourceId:string;eventId:string;threadId:string;generation:number;policyRevision:number};
export interface WorkInputReceipt {
    workId:string;
    inputId:string;
    round:number;
    controlRevision:number;
    status:'accepted';
    taskIds:string[];
    checkpointRef:string;
}
type Query=Pick<PoolClient,'query'>;

/** One bounded, explicitly requested new round. Running/unknown work is never replayed. */
export class WorkContinuity {
    constructor(readonly host:Framework,readonly queue:TaskQueue,readonly work:WorkCoordinator){}
    private async read<T>(operation:(client:PoolClient)=>Promise<T>){
        const client=await this.host.db.pool.connect();
        try{await client.query('BEGIN');await this.host.organization.lock(client);const result=await operation(client);await client.query('COMMIT');return result;}
        catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }
    private async authorize(principalId:string,id:string,client:Query=this.host.db.pool){
        const actor=await this.host.db.get<Actor>('actors',principalId,client);
        const snapshot=await this.work.snapshot(id,client);
        if(!actor.active||actor.companyId!==snapshot.work.company_id)fail('PERMISSION_DENIED','Work is outside current company scope');
        const original=(await client.query('SELECT a.agent_id,a.owner_id,coalesce(t.data->>\'budgetGroupId\',a.work_id::text) AS budget_group_id FROM work_assignments a JOIN tasks t ON t.id=a.task_id WHERE a.work_id=$1 ORDER BY a.agent_id',[id])).rows;
        for(const row of original)await this.host.organization.authorizeAgent(actor.id,row.agent_id,'read',client);
        return{actor,snapshot,original};
    }
    async append(principalId:string,id:string,input:WorkInput,entry:WorkEntry,options?:{resume:WorkControlRequest}):Promise<WorkInputReceipt>{
        requireUuid(id);
        if(!/^[a-f0-9]{64}$/u.test(input.revision??'')||!input.idempotencyKey?.trim()||input.idempotencyKey.length>160||!Array.isArray(input.assignments)||input.assignments.length<1||input.assignments.length>8||new Set(input.assignments.map(a=>a.agentId)).size!==input.assignments.length||input.assignments.some(a=>typeof a.prompt!=='string'||!a.prompt.trim()||a.prompt.length>8000))fail('INVALID_INPUT','Provide a revision, input key and one to eight distinct work assignments');
        const client=await this.host.db.pool.connect();
        try{
            await client.query('BEGIN');await this.host.organization.lock(client);
            await client.query('SELECT id FROM work_items WHERE id=$1 FOR UPDATE',[id]);
            const {actor,snapshot,original}=await this.authorize(principalId,id,client);
            if(options)await this.work.control.authorize(client,principalId,id);
            const acceptedAgents=[];
            for(const assignment of input.assignments){
                if(!original.some(row=>row.agent_id===assignment.agentId))fail('PERMISSION_DENIED','Follow-up cannot expand the original work participants');
                const {agent}=await this.host.organization.authorizeAgent(actor.id,assignment.agentId,'dispatch',client);
                await this.work.authorizeExecution(actor.id,id,agent.id,client);
                acceptedAgents.push({agentId:agent.id,ownerId:agent.ownerId,revision:contentHash(agent),bindings:this.host.bindings(agent).map(b=>({pluginId:b.pluginId,pluginVersion:b.pluginVersion}))});
            }
            const key=contentHash([actor.companyId,id,actor.id,input.idempotencyKey]),hash=contentHash(input);
            const controlKey=contentHash([actor.companyId,id,actor.id,'work-control',input.idempotencyKey]);
            if(options){const priorControl=(await client.query('SELECT input_hash,data FROM work_controls WHERE request_key=$1',[controlKey])).rows[0];if(priorControl){if(priorControl.input_hash!==contentHash(options.resume))fail('CONFLICT','Control command identity changed');await client.query('COMMIT');return priorControl.data.receipt;}}
            const prior=(await client.query('SELECT input_hash,data FROM work_inputs WHERE request_key=$1',[key])).rows[0];
            if(prior){if(prior.input_hash!==hash)fail('CONFLICT','Work input key was reused with different content');await client.query('COMMIT');return prior.data.receipt;}
            if(entry.kind==='event')await this.host.events.authorizeInput(client,actor.id,id,input.assignments.map(a=>a.agentId),entry);
            if(snapshot.revision!==input.revision)fail('CONFLICT','Work changed; read its current revision before continuing');
            if(options){const pending=await this.work.control.unsettled(client,id,snapshot);if(pending.running||pending.unknown||!['waiting','stopped','reconciliation_required'].includes(snapshot.work.control_mode)&&snapshot.state!=='needs_attention')fail('CONFLICT','Work must be stopped/waiting and all uncertain results reconciled before resuming');}
            else if(snapshot.work.control_mode!=='active'||!['waiting_review','changes_requested','completed'].includes(snapshot.state)||!snapshot.tasks.length||snapshot.tasks.some(t=>t.state!=='succeeded'))fail('CONFLICT','Finish and reconcile the current round before explicitly continuing');
            if(snapshot.work.current_round>=32)fail('BUDGET_EXCEEDED','This work reached its explicit round limit');
            const budgetGroups=[...new Set<string>(original.map(row=>row.budget_group_id))];
            if(budgetGroups.length!==1)fail('CONFLICT','Original work budget ownership needs reconciliation');
            const budgetGroupId=budgetGroups[0]!;
            const round=snapshot.work.current_round+1,controlRevision=snapshot.work.control_revision+1,inputId=randomUUID(),checkpointId=randomUUID();
            await client.query('INSERT INTO work_checkpoints(id,work_id,round,revision,data) VALUES($1,$2,$3,$4,$5)',[checkpointId,id,snapshot.work.current_round,snapshot.revision,JSON.stringify({actionScope:snapshot.work.action_scope,confirmedTasks:snapshot.tasks.filter(t=>t.state==='succeeded').map(t=>({taskId:t.id,agentId:t.agent_id,ownerId:t.owner_id,state:t.state,runId:t.data.runId??null})),priorTasks:snapshot.tasks.map(t=>({taskId:t.id,state:t.state,runId:t.data.runId??null})),resume:!!options})]);
            if(snapshot.review)await client.query('INSERT INTO work_review_history(work_id,round,revision,reviewed_by,decision,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[id,snapshot.work.current_round,snapshot.review.revision,snapshot.review.reviewed_by,snapshot.review.decision,snapshot.review.reason,snapshot.review.created_at]);
            const taskIds=[];
            for(const assignment of input.assignments){
                const taskId=await this.queue.enqueueInTransaction(client,{principalId:actor.id,agentId:assignment.agentId,prompt:assignment.prompt,idempotencyKey:'work-input:'+inputId+':'+assignment.agentId,workId:id,workRound:round,workInputId:inputId,workControlRevision:controlRevision,budgetGroupId});
                const agent=acceptedAgents.find(a=>a.agentId===assignment.agentId)!;
                await client.query('INSERT INTO work_round_assignments(work_id,round,task_id,agent_id,owner_id) VALUES($1,$2,$3,$4,$5)',[id,round,taskId,agent.agentId,agent.ownerId]);taskIds.push(taskId);
            }
            const receipt:WorkInputReceipt={workId:id,inputId,round,controlRevision,status:'accepted',taskIds,checkpointRef:checkpointId};
            const authorization={companyId:actor.companyId,initiatedBy:actor.id,actorRevision:contentHash(actor),scope:'original-work-participants',budgetGroupId,agents:acceptedAgents};
            await client.query('INSERT INTO work_inputs(id,work_id,round,principal_id,request_key,input_hash,data) VALUES($1,$2,$3,$4,$5,$6,$7)',[inputId,id,round,actor.id,key,hash,JSON.stringify({entry,assignments:input.assignments,authorization,receipt})]);
            await client.query("UPDATE work_items SET current_round=$2,control_revision=$3,control_mode='active',control_data='{}'::jsonb,action_scope=$4,observed_at=NULL,observed_state=NULL WHERE id=$1",[id,round,controlRevision,options?snapshot.work.action_scope:round]);
            if(options)await client.query('INSERT INTO work_controls(id,work_id,principal_id,request_key,input_hash,data) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,actor.id,controlKey,contentHash(options.resume),JSON.stringify({action:'resume',reason:options.resume.reason,receipt,resumeOfRound:snapshot.work.current_round})]);
            await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)',[randomUUID(),'work.input_accepted',JSON.stringify({companyId:actor.companyId,principalId:actor.id,workId:id,inputId,round,controlRevision,entry:entry.kind,taskIds,checkpointId})]);
            await client.query('COMMIT');return receipt;
        }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }
    async history(principalId:string,id:string){
        return this.read(async client=>{
        const {snapshot}=await this.authorize(principalId,id,client);
        const assignments=(await client.query('SELECT 1 AS round,a.agent_id,a.owner_id,t.id,t.state,t.data FROM work_assignments a JOIN tasks t ON t.id=a.task_id WHERE a.work_id=$1 UNION ALL SELECT a.round,a.agent_id,a.owner_id,t.id,t.state,t.data FROM work_round_assignments a JOIN tasks t ON t.id=a.task_id WHERE a.work_id=$1 ORDER BY round,agent_id',[id])).rows;
        const inputs=(await client.query('SELECT id,round,principal_id,data,created_at FROM work_inputs WHERE work_id=$1 ORDER BY round',[id])).rows;
        const reviews=(await client.query('SELECT round,revision,reviewed_by,decision,reason,created_at FROM work_review_history WHERE work_id=$1 ORDER BY round,created_at',[id])).rows;
        const checkpoints=(await client.query('SELECT id,round,revision,created_at FROM work_checkpoints WHERE work_id=$1 ORDER BY round',[id])).rows;
        if(snapshot.review&&!reviews.some(r=>r.revision===snapshot.review.revision))reviews.push({round:snapshot.work.current_round,...snapshot.review});
        return{workId:id,currentRound:snapshot.work.current_round,controlRevision:snapshot.work.control_revision,rounds:Array.from({length:snapshot.work.current_round},(_,index)=>({round:index+1,assignments:assignments.filter(a=>a.round===index+1).map(a=>({taskId:a.id,agentId:a.agent_id,ownerId:a.owner_id,state:a.state,runId:a.data.runId??null}))})),inputs:inputs.map(i=>({id:i.id,round:i.round,principalId:i.principal_id,entry:i.data.entry,createdAt:i.created_at})),reviews,checkpoints};
        });
    }
    async input(principalId:string,id:string,inputId:string){
        return this.read(async client=>{
        requireUuid(inputId);await this.authorize(principalId,id,client);
        const row=(await client.query('SELECT id,round,principal_id,data,created_at FROM work_inputs WHERE work_id=$1 AND id=$2',[id,inputId])).rows[0];
        if(!row)fail('NOT_FOUND','Work input does not exist');return{id:row.id,round:row.round,principalId:row.principal_id,...row.data,createdAt:row.created_at};
        });
    }
    async checkpointForTask(principalId:string,taskId:string,runId?:string){
        const sources:import('./provenance.js').SourceOrigin[]=[];let executionAgent='';
        const projection=await this.read(async client=>{
        requireUuid(taskId);
        const task=(await client.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
        if(!task?.data.workInputId)fail('NOT_FOUND','Task has no continuation checkpoint');
        const {actor,agent}=await this.host.authorize(principalId,task.agent_id,'read',client);
        if(actor.id!==agent.ownerId||task.data.executionPrincipalId!==actor.id)fail('PERMISSION_DENIED','Checkpoint belongs to another executor');executionAgent=agent.id;
        const input=(await client.query('SELECT data FROM work_inputs WHERE id=$1 AND work_id=$2',[task.data.workInputId,task.data.workId])).rows[0];
        const checkpoint=(await client.query('SELECT * FROM work_checkpoints WHERE id=$1 AND work_id=$2',[input?.data.receipt.checkpointRef,task.data.workId])).rows[0];
        if(!checkpoint)fail('NOT_FOUND','Checkpoint does not exist');
        const reference=checkpoint.data.confirmedTasks.find((t:any)=>t.agentId===agent.id&&t.ownerId===actor.id);
        const previous=reference?(await client.query('SELECT data FROM tasks WHERE id=$1 AND agent_id=$2',[reference.taskId,agent.id])).rows[0]:null;
        const confirmedActions=checkpoint.data.resume?(await client.query("SELECT a.id,a.data->>'toolRef' AS tool,a.data->>'inputHash' AS input_hash,a.data->'dependencies' AS dependencies,left((a.data->'value')::text,1000) AS receipt,coalesce(a.data->>'confirmationSource','host') AS source FROM work_actions a JOIN tasks t ON t.id=a.task_id WHERE a.work_id=$1 AND a.action_scope=$2 AND a.agent_id=$3 AND t.data->>'executionPrincipalId'=$4 AND a.state='succeeded' ORDER BY a.created_at LIMIT 32",[task.data.workId,checkpoint.data.actionScope,agent.id,actor.id])).rows:[];
        for(const action of confirmedActions){if(action.dependencies&&!(await this.host.provenance.status(actor.id,action.dependencies,client)).visible){action.receipt='回执受当前资料权限保护；已完成状态保留，不得重做。';action.receiptAvailable=false;delete action.input_hash;}if(action.receiptAvailable!==false)sources.push(...(action.dependencies??[{kind:'unknown',id:'legacy-action:'+action.id,ownerId:actor.id,companyId:actor.companyId}]));delete action.dependencies;}
        await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)',[randomUUID(),'work.checkpoint_read',JSON.stringify({companyId:actor.companyId,principalId:actor.id,agentId:agent.id,workId:task.data.workId,taskId,checkpointId:checkpoint.id})]);
        return{checkpointId:checkpoint.id,sourceRound:checkpoint.round,sourceRevision:checkpoint.revision,confirmedTask:reference?{...reference,summary:previous?.data.resultFormat?'执行记录待整理或核实':String(previous?.data.output??'').slice(0,2000)}:null,confirmedActions,actionReceiptsLimit:32,receiptExcerptChars:1000,summaryTruncated:!previous?.data.resultFormat&&String(previous?.data.output??'').length>2000,notice:'These are confirmed previous results, not permission to replay actions. Execute only the new authorized instruction.'};
        });
        const result=projection.confirmedTask?await this.host.results.view(principalId,projection.confirmedTask.taskId):null;
        if(projection.confirmedTask){const row=(await this.host.db.pool.query('SELECT dependencies FROM task_results WHERE task_id=$1',[projection.confirmedTask.taskId])).rows[0];const origins=row?.dependencies??[{kind:'unknown',id:'legacy-checkpoint:'+projection.confirmedTask.taskId,ownerId:principalId}];if(!result||result.facts.length||result.artifacts.length||result.issues.length||result.processAvailable)sources.push(...origins);}
        if(runId&&sources.length)await this.host.provenance.add(runId,principalId,executionAgent,this.host.provenance.unique(sources));
        return result?{...projection,summaryTruncated:false,confirmedTask:{...projection.confirmedTask,summary:result.summary,result}}:projection;
    }
}
