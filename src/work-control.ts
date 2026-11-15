import{randomUUID}from'node:crypto';
import type{PoolClient}from'pg';
import type{Framework}from'./index.js';
import type{TaskQueue,TaskRequest}from'./tasks.js';
import type{WorkCoordinator}from'./work.js';
import type{Actor}from'./types.js';
import{contentHash,requireUuid}from'./contracts.js';
import{fail}from'./errors.js';
import{WorkActions}from'./work-actions.js';

export interface WorkControlRequest{revision:string;idempotencyKey:string;action:'stop'|'wait'|'resume';reason:string;waitReason?:'human_decision'|'dependency'|'environment_unavailable';question?:string;assignments?:Array<{agentId:string;prompt:string}>;}
export interface WorkReconciliation{revision:string;idempotencyKey:string;reason:string;evidenceRefs:string[];actions?:Array<{actionId:string;outcome:'succeeded'|'not_executed';value?:unknown}>;tasks?:Array<{taskId:string;outcome:'closed'}>;}
export class WorkControl{
    readonly actions:WorkActions;
    constructor(readonly host:Framework,readonly queue:TaskQueue,readonly work:WorkCoordinator){this.actions=new WorkActions(this);}
    async transaction<T>(fn:(client:PoolClient)=>Promise<T>){const client=await this.host.db.pool.connect();try{await client.query('BEGIN');await this.host.organization.lock(client);const value=await fn(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
    async authorize(client:Pick<PoolClient,'query'>,principalId:string,id:string,review=false){
        requireUuid(id);const actor=await this.host.db.get<Actor>('actors',principalId,client),snapshot=await this.work.snapshot(id,client);
        if(!actor.active||actor.companyId!==snapshot.work.company_id)fail('PERMISSION_DENIED','Work control is outside company scope');
        if(!review&&actor.role!=='admin'&&actor.id!==snapshot.work.created_by&&!actor.permissions.includes('team.dispatch'))fail('PERMISSION_DENIED','Controlling a shared work requires explicit dispatch authority');
        const targets=(await client.query('SELECT agent_id,owner_id FROM work_assignments WHERE work_id=$1',[id])).rows;
        for(const target of targets){
            const{agent}=await this.host.organization.authorizeAgent(actor.id,target.agent_id,'read',client);
            if(review)await this.host.organization.authorizeAgent(actor.id,target.agent_id,'review',client);
            else if(actor.role!=='admin'&&!actor.permissions.includes('agent.execute:'+agent.id))await this.host.organization.authorize(actor.id,agent.ownerId,'dispatch',client);
            if(review&&actor.role!=='admin'&&(actor.id===target.owner_id||!actor.permissions.includes('team.review')))fail('PERMISSION_DENIED','Independent human review is required');
        }
        return{actor,snapshot};
    }
    async guard(request:TaskRequest,client:Pick<PoolClient,'query'>=this.host.db.pool){
        if(!request.workId)return;
        const row=(await client.query('SELECT current_round,control_revision,control_mode,action_scope FROM work_items WHERE id=$1',[request.workId])).rows[0];
        if(!row||row.control_mode!=='active'||row.current_round!==(request.workRound??1)||row.control_revision!==(request.workControlRevision??0))fail('CANCELLED','Work control closed this execution attempt');
        const unknown=(await client.query("SELECT id FROM work_actions WHERE work_id=$1 AND action_scope=$2 AND state='unknown' LIMIT 1",[request.workId,row.action_scope])).rowCount;
        if(unknown)fail('RESULT_UNKNOWN','A previous work action must be reconciled first');
    }
    async authorizeRead(client:Pick<PoolClient,'query'>,principalId:string,id:string){
        try{return await this.authorize(client,principalId,id);}catch(error){if((error as any).code!=='PERMISSION_DENIED')throw error;return this.authorize(client,principalId,id,true);}
    }
    private async canReadPayload(client:Pick<PoolClient,'query'>,principalId:string,agentId:string,tool:string){
        let privateMemory=tool.startsWith('memory_write@');
        const versionAt=tool.lastIndexOf('@'),colon=tool.lastIndexOf(':');
        if(colon>0&&versionAt>colon){
            const plugin=this.host.registry.list().find(p=>p.id===tool.slice(0,colon)&&p.version===tool.slice(versionAt+1));
            if(!plugin)return false;
            const declaration=plugin.manifest.provides.tools.find(t=>t.id===tool.slice(colon+1,versionAt));
            const services=declaration?.hostServices??(plugin.manifest.schemaVersion==='0.1.0'&&declaration?.effect!=='read'?plugin.manifest.permissions:[]);
            privateMemory||=services.some(permission=>permission.startsWith('memory.'));
        }
        if(!privateMemory)return true;
        try{await this.host.authorizeMemory(principalId,agentId,'read',client);return true;}catch(error){if((error as any).code!=='PERMISSION_DENIED')throw error;return false;}
    }
    async guardRun(runId:string){
        if(!/^[a-f0-9-]{36}$/iu.test(runId))return;
        const run=(await this.host.db.pool.query('SELECT data FROM runs WHERE id=$1',[runId])).rows[0];
        if(!run?.data.workId)return;
        const task=(await this.host.db.pool.query('SELECT * FROM tasks WHERE id=$1',[run.data.taskId])).rows[0];
        if(!task)fail('CANCELLED','Work task no longer exists');
        await this.guard({...task.data,principalId:task.data.executionPrincipalId,agentId:task.agent_id,taskId:task.id});
    }
    async command(principalId:string,id:string,input:WorkControlRequest){
        if(!/^[a-f0-9]{64}$/u.test(input.revision??'')||!input.idempotencyKey?.trim()||input.idempotencyKey.length>160||!input.reason?.trim()||input.reason.length>1000||!['stop','wait','resume'].includes(input.action))fail('INVALID_INPUT','A version, command identity and explicit reason are required');
        if(input.action==='resume')return this.work.continuity.append(principalId,id,{revision:input.revision,idempotencyKey:input.idempotencyKey,assignments:input.assignments??[]},{kind:'control_resume'},{resume:input});
        return this.closeAdmission(principalId,id,input);
    }
    async waitFromTask(request:TaskRequest,input:{reason:'human_decision'|'dependency'|'environment_unavailable';question:string}){
        if(!request.workId||!request.taskId||!['human_decision','dependency','environment_unavailable'].includes(input.reason)||!input.question?.trim()||input.question.length>1000)fail('INVALID_INPUT','A bound work task and concrete wait question are required');
        return this.closeAdmission(request.principalId,request.workId,{revision:'',idempotencyKey:'task-wait:'+request.taskId+':'+contentHash(input),action:'wait',reason:'Executing employee requested assistance',waitReason:input.reason,question:input.question},request);
    }
    private async closeAdmission(principalId:string,id:string,input:WorkControlRequest,request?:TaskRequest){
        if(input.question!==undefined&&(typeof input.question!=='string'||input.question.length>1000)||input.waitReason&&!['human_decision','dependency','environment_unavailable'].includes(input.waitReason))fail('INVALID_INPUT','Invalid wait details');
        const result=await this.transaction(async client=>{
            await client.query('SELECT id FROM work_items WHERE id=$1 FOR UPDATE',[id]);
            let authorized;
            if(request){
                await this.guard(request,client);const task=(await client.query('SELECT * FROM tasks WHERE id=$1',[request.taskId])).rows[0];
                const{actor,agent}=await this.host.authorize(principalId,request.agentId,'execute',client);
                if(!task||task.state!=='running'||task.agent_id!==agent.id||task.data.executionPrincipalId!==actor.id||agent.ownerId!==actor.id||task.data.workId!==id)fail('PERMISSION_DENIED','Wait belongs to another executing task');
                authorized={actor,snapshot:await this.work.snapshot(id,client)};
            }else authorized=await this.authorize(client,principalId,id);
            const{actor,snapshot}=authorized;
            const key=contentHash([actor.companyId,id,actor.id,'work-control',input.idempotencyKey]),hash=contentHash(input);
            const prior=(await client.query('SELECT input_hash,data FROM work_controls WHERE request_key=$1',[key])).rows[0];if(prior){if(prior.input_hash!==hash)fail('CONFLICT','Control key was reused with different content');return{receipt:prior.data.receipt,fresh:false};}
            if(!request&&snapshot.revision!==input.revision)fail('CONFLICT','Work changed; read its current version');
            if(snapshot.work.control_mode==='stop_requested'&&input.action!=='stop')fail('CONFLICT','Stop takes priority over another wait request');
            const controlId=randomUUID(),revision=snapshot.work.control_revision+1,targetState=input.action==='stop'?'stopped':'waiting';
            const receipt={workId:id,controlId,controlRevision:revision,status:'stop_requested',targetState};
            const data={targetState,reason:input.reason,waitReason:input.action==='wait'?(input.waitReason??'human_decision'):null,question:input.question??null,requestedBy:actor.id,taskId:request?.taskId??null,controlId};
            await client.query("UPDATE work_items SET control_mode='stop_requested',control_revision=$2,control_data=$3,observed_at=NULL,observed_state=NULL WHERE id=$1",[id,revision,JSON.stringify(data)]);
            await this.cancelQueued(client,id,snapshot.work.current_round);
            await client.query('INSERT INTO work_controls(id,work_id,principal_id,request_key,input_hash,data) VALUES($1,$2,$3,$4,$5,$6)',[controlId,id,actor.id,key,hash,JSON.stringify({action:input.action,reason:input.reason,receipt,question:input.question??null})]);
            await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)',[randomUUID(),'work.control_requested',JSON.stringify({companyId:actor.companyId,principalId:actor.id,workId:id,controlId,controlRevision:revision,targetState})]);return{receipt,fresh:true};
        });
        if(result.fresh){void this.queue.stopWork(id).catch(()=>this.host.db.audit('work.stop_owner_unavailable',{workId:id}));await this.settle(id);}return result.receipt;
    }
    async status(principalId:string,id:string){return this.transaction(async client=>{
        const{snapshot}=await this.authorizeRead(client,principalId,id);
        const actions=(await client.query("SELECT id,action_scope,agent_id,task_id,run_id,state,data->>'toolRef' AS tool,left((data->'input')::text,240) AS input_preview,length((data->'input')::text)>240 AS input_truncated,created_at,updated_at FROM work_actions WHERE work_id=$1 ORDER BY (action_scope=$2 AND state IN ('unknown','running')) DESC,created_at DESC,id LIMIT 257",[id,snapshot.work.action_scope])).rows;
        for(const action of actions)if(!await this.canReadPayload(client,principalId,action.agent_id,action.tool)){action.input_preview='私有记忆操作：需要独立记忆权限';action.input_truncated=false;action.input_restricted=true;}
        const controls=(await client.query('SELECT id,principal_id,data,created_at FROM work_controls WHERE work_id=$1 ORDER BY created_at DESC LIMIT 128',[id])).rows;
        const reconciliations=(await client.query('SELECT id,task_id,action_id,reviewed_by,data,created_at FROM work_reconciliations WHERE work_id=$1 ORDER BY created_at DESC LIMIT 256',[id])).rows;
        return{workId:id,mode:snapshot.work.control_mode,controlRevision:snapshot.work.control_revision,control:snapshot.work.control_data,actions:actions.slice(0,256),actionsLimit:256,actionsTruncated:actions.length>256,controls,reconciliations};
    });}
    async action(principalId:string,id:string,actionId:string){return this.transaction(async client=>{
        requireUuid(actionId);await this.authorizeRead(client,principalId,id);
        const row=(await client.query('SELECT * FROM work_actions WHERE work_id=$1 AND id=$2',[id,actionId])).rows[0];if(!row)fail('NOT_FOUND','Action does not belong to this work');
        const input=JSON.stringify(row.data.input??null),attempts=(await client.query("SELECT id,task_id,run_id,state,created_at,updated_at,data->>'error' AS error,data?'lateReceipt' AS has_late_receipt FROM work_action_attempts WHERE action_id=$1 ORDER BY created_at DESC LIMIT 32",[actionId])).rows;
        const readable=await this.canReadPayload(client,principalId,row.agent_id,row.data.toolRef);
        return{actionId,tool:row.data.toolRef,state:row.state,agentId:row.agent_id,taskId:row.task_id,input:readable&&input.length<=32000?row.data.input:undefined,inputExcerpt:readable?input.slice(0,32000):'私有记忆操作：需要独立记忆权限',inputRestricted:!readable,inputTruncated:readable&&input.length>32000,inputHash:readable?row.data.inputHash:undefined,receipt:readable?(row.data.value??null):null,confirmationSource:row.data.confirmationSource??null,attempts,attemptsLimit:32};
    });}
    async reconcile(principalId:string,id:string,input:WorkReconciliation){
        if(!/^[a-f0-9]{64}$/u.test(input.revision??'')||!input.idempotencyKey?.trim()||input.idempotencyKey.length>160||!input.reason?.trim()||input.reason.length>1000||!Array.isArray(input.evidenceRefs)||!input.evidenceRefs.length||input.evidenceRefs.length>16||input.evidenceRefs.some(r=>typeof r!=='string'||!r.trim()||r.length>240)||(!input.actions?.length&&!input.tasks?.length)||(input.actions?.length??0)>16||(input.tasks?.length??0)>16)fail('INVALID_INPUT','Human reconciliation requires concrete evidence and affected references');
        const result=await this.transaction(async client=>{
            await client.query('SELECT id FROM work_items WHERE id=$1 FOR UPDATE',[id]);const{actor,snapshot}=await this.authorize(client,principalId,id,true);
            const key=contentHash([actor.companyId,id,actor.id,'work-control',input.idempotencyKey]),hash=contentHash({action:'reconcile',...input});
            const prior=(await client.query('SELECT input_hash,data FROM work_controls WHERE request_key=$1',[key])).rows[0];if(prior){if(prior.input_hash!==hash)fail('CONFLICT','Decision identity changed');return prior.data.receipt;}
            if(snapshot.revision!==input.revision)fail('CONFLICT','Work changed before human reconciliation');
            if((await this.unsettled(client,id,snapshot)).running)fail('CONFLICT','The previous executor or admitted action is still active');
            const controlId=randomUUID();
            for(const action of input.actions??[]){
                requireUuid(action.actionId);if(!['succeeded','not_executed'].includes(action.outcome)||action.outcome==='succeeded'&&!Object.hasOwn(action,'value')||Buffer.byteLength(JSON.stringify(action.value)??'null')>131072)fail('INVALID_INPUT','A confirmed action needs its actual bounded receipt value');
                const row=(await client.query('SELECT * FROM work_actions WHERE id=$1 AND work_id=$2 AND action_scope=$3 FOR UPDATE',[action.actionId,id,snapshot.work.action_scope])).rows[0];if(!row||row.state!=='unknown')fail('CONFLICT','Only an uncertain action in this recovery chain can be reconciled');
                if(action.outcome==='succeeded'&&!await this.canReadPayload(client,principalId,row.agent_id,row.data.toolRef))fail('PERMISSION_DENIED','Confirming a private-memory receipt requires its independent memory grant');
                if(action.outcome==='succeeded')await this.actions.validateReceipt(row.data.toolRef,action.value);
                const resolutionId=randomUUID(),data={source:'human',outcome:action.outcome,reason:input.reason,evidenceRefs:input.evidenceRefs,controlId};
                await client.query('INSERT INTO work_reconciliations(id,work_id,action_id,reviewed_by,data) VALUES($1,$2,$3,$4,$5)',[resolutionId,id,row.id,actor.id,JSON.stringify(data)]);
                await client.query('UPDATE work_actions SET state=$2,data=data||$3::jsonb,updated_at=now() WHERE id=$1',[row.id,action.outcome,JSON.stringify({...(action.outcome==='succeeded'?{value:action.value}:{}),resolutionRef:resolutionId,confirmationSource:'human'})]);
            }
            for(const task of input.tasks??[]){requireUuid(task.taskId);if(task.outcome!=='closed'||!snapshot.tasks.some(t=>t.id===task.taskId&&t.state==='reconciliation_required'))fail('CONFLICT','Only an interrupted current task can be confirmed closed');await client.query('INSERT INTO work_reconciliations(id,work_id,task_id,reviewed_by,data) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,task.taskId,actor.id,JSON.stringify({source:'human',outcome:'closed',reason:input.reason,evidenceRefs:input.evidenceRefs,controlId})]);}
            const revision=snapshot.work.control_revision+1,receipt={workId:id,controlId,controlRevision:revision,status:'human_verified'};
            await client.query('UPDATE work_items SET control_revision=$2,observed_state=NULL WHERE id=$1',[id,revision]);
            await client.query('INSERT INTO work_controls(id,work_id,principal_id,request_key,input_hash,data) VALUES($1,$2,$3,$4,$5,$6)',[controlId,id,actor.id,key,hash,JSON.stringify({action:'reconcile',reason:input.reason,evidenceRefs:input.evidenceRefs,receipt})]);
            await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)',[randomUUID(),'work.human_reconciled',JSON.stringify({companyId:actor.companyId,principalId:actor.id,workId:id,controlId,controlRevision:revision})]);return receipt;
        });await this.settle(id);return result;
    }
    async cancelQueued(client:PoolClient,id:string,round:number){
        await client.query("UPDATE tasks SET state='cancelled',data=data||$3::jsonb,updated_at=now() WHERE state='queued' AND id IN (SELECT task_id FROM work_assignments WHERE work_id=$1 AND $2=1 UNION ALL SELECT task_id FROM work_round_assignments WHERE work_id=$1 AND round=$2)",[id,round,JSON.stringify({controlStopped:true})]);
    }
    async unsettled(client:PoolClient,id:string,snapshot:any){
        const running=snapshot.tasks.some((t:any)=>['running','queued'].includes(t.state))||(await client.query("SELECT id FROM work_actions WHERE work_id=$1 AND action_scope=$2 AND state='running' LIMIT 1",[id,snapshot.work.action_scope])).rowCount;
        const unknownTasks=[];for(const task of snapshot.tasks)if(task.state==='reconciliation_required'&&!(await client.query('SELECT id FROM work_reconciliations WHERE work_id=$1 AND task_id=$2',[id,task.id])).rowCount)unknownTasks.push(task.id);
        const unknownActions=(await client.query("SELECT id FROM work_actions WHERE work_id=$1 AND action_scope=$2 AND state='unknown'",[id,snapshot.work.action_scope])).rows;
        return{running:!!running,unknown:unknownTasks.length>0||unknownActions.length>0};
    }
    async settle(id:string){
        await this.transaction(async client=>{
            await client.query('SELECT id FROM work_items WHERE id=$1 FOR UPDATE',[id]);const snapshot=await this.work.snapshot(id,client),pending=await this.unsettled(client,id,snapshot);
            const mode=snapshot.work.control_mode;
            if(mode==='active'&&pending.unknown){await client.query("UPDATE work_items SET control_mode='reconciliation_required',control_revision=control_revision+1,control_data=$2,observed_state=NULL WHERE id=$1",[id,JSON.stringify({targetState:'waiting',waitReason:'reconciliation',reason:'Execution outcome requires human verification'})]);await this.cancelQueued(client,id,snapshot.work.current_round);}
            else if(['stop_requested','reconciliation_required'].includes(mode)&&!pending.running){const next=pending.unknown?'reconciliation_required':snapshot.work.control_data.targetState??'waiting';await client.query('UPDATE work_items SET control_mode=$2,observed_state=NULL WHERE id=$1 AND control_mode<>$2',[id,next]);}
        });
    }
    async recoverInterrupted(){
        await this.host.db.pool.query("UPDATE work_action_attempts SET state='unknown',data=data||'{\"interrupted\":true}'::jsonb,updated_at=now() WHERE state='running'");
        const ids=(await this.host.db.pool.query("UPDATE work_actions SET state='unknown',data=data||'{\"interrupted\":true}'::jsonb WHERE state='running' RETURNING work_id")).rows.map(r=>r.work_id);
        const works=(await this.host.db.pool.query("SELECT id FROM work_items WHERE control_mode IN ('active','stop_requested','reconciliation_required')")).rows;
        for(const id of new Set([...ids,...works.map(w=>w.id)]))await this.settle(id);
    }
}
