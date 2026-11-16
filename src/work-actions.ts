import{randomUUID}from'node:crypto';
import type{TaskRequest}from'./tasks.js';
import type{WorkControl}from'./work-control.js';
import{contentHash}from'./contracts.js';
import{fail,ActionNotStartedError,FrameworkError}from'./errors.js';

/** Effect receipts, scoped to one explicit work recovery chain, never to global tool inputs. */
export class WorkActions{
    constructor(readonly control:WorkControl){}
    async validateReceipt(toolRef:string,value:any){
        if(value&&typeof value==='object'&&'outcome'in value&&value.outcome!=='succeeded')fail('INVALID_INPUT','A failed or unknown receipt cannot confirm success');
        const separator=toolRef.lastIndexOf('@'),ref=toolRef.slice(0,separator),version=toolRef.slice(separator+1);
        if(ref.includes(':')){
            // Disabling execution must not prevent validating a historical/admitted receipt.
            const colon=ref.lastIndexOf(':'),plugin=this.control.host.registry.list().find(p=>p.id===ref.slice(0,colon)&&p.version===version);
            if(!plugin)fail('INVALID_INPUT','The exact installed action schema is unavailable');
            const tool=plugin.manifest.provides.tools.find(t=>t.id===ref.slice(colon+1));
            if(!tool||!value||value.outcome!=='succeeded'||typeof value.invocationId!=='string'||typeof value.runId!=='string'||!Array.isArray(value.evidenceRefs)||!value.evidenceRefs.length||value.evidenceRefs.some((r:any)=>typeof r!=='string'||!r))fail('INVALID_INPUT','A plugin action requires its complete successful receipt');
            try{await this.control.host.registry.validateTool(plugin,tool,value.output,true);}catch{fail('INVALID_INPUT','Confirmed plugin output must match its installed schema');}
        }
        if(ref==='report_record'&&typeof value?.evidenceRef!=='string')fail('INVALID_INPUT','A report confirmation requires its actual evidence reference');
        if(ref==='memory_write'&&(!value||typeof value.noteId!=='string'||!Number.isInteger(value.version)||typeof value.markdown!=='string'||!Array.isArray(value.sourceRefs)))fail('INVALID_INPUT','A memory confirmation requires its actual versioned note');
    }
    async execute<T>(request:TaskRequest,toolRef:string,input:unknown,execute:()=>Promise<T>,runId?:string):Promise<{value:T;reused:boolean;actionId:string|null}>{
        if(!request.workId)return{value:await execute(),reused:false,actionId:null};
        const host=this.control.host;
        const dependencies=runId?await host.provenance.snapshot(runId):undefined;
        const admission=await this.control.transaction(async client=>{
            await client.query('SELECT id FROM work_items WHERE id=$1 FOR UPDATE',[request.workId]);await this.control.guard(request,client);
            const task=(await client.query('SELECT * FROM tasks WHERE id=$1',[request.taskId])).rows[0];
            if(!task||task.agent_id!==request.agentId||task.data.executionPrincipalId!==request.principalId||task.data.workId!==request.workId||task.state!=='running')fail('PERMISSION_DENIED','Action is not bound to the current executing task');
            const work=(await client.query('SELECT action_scope FROM work_items WHERE id=$1',[request.workId])).rows[0];
            const key=contentHash([request.workId,work.action_scope,request.agentId,toolRef,contentHash(input)]);
            const prior=(await client.query('SELECT * FROM work_actions WHERE action_key=$1 FOR UPDATE',[key])).rows[0];
            if(prior?.state==='succeeded'){await this.validateReceipt(toolRef,prior.data.value);await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)',[randomUUID(),'work.action_reused',JSON.stringify({workId:request.workId,taskId:request.taskId,agentId:request.agentId,actionId:prior.id,runId})]);return{actionId:prior.id as string,reused:true,value:prior.data.value as T,attemptId:null};}
            if(prior&&prior.state!=='not_executed')fail('RESULT_UNKNOWN','An action is pending or uncertain; do not replay it');
            const actionId=prior?.id??randomUUID(),attemptId=randomUUID();
            if(prior)await client.query("UPDATE work_actions SET state='running',updated_at=now() WHERE id=$1",[actionId]);
            else await client.query('INSERT INTO work_actions(id,work_id,action_scope,agent_id,task_id,run_id,action_key,state,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[actionId,request.workId,work.action_scope,request.agentId,request.taskId,runId??null,key,'running',JSON.stringify({toolRef,input,inputHash:contentHash(input),dependencies})]);
            await client.query('INSERT INTO work_action_attempts(id,action_id,task_id,run_id,state,data) VALUES($1,$2,$3,$4,$5,$6)',[attemptId,actionId,request.taskId,runId??null,'running',JSON.stringify({controlRevision:request.workControlRevision??0})]);
            return{actionId:actionId as string,attemptId,reused:false,value:undefined};
        });
        if(admission.reused)return{value:admission.value!,reused:true,actionId:admission.actionId};
        try{
            const value=await execute();
            await this.validateReceipt(toolRef,value);
            if(value&&typeof value==='object'&&'outcome'in value&&(value as any).outcome!=='succeeded')fail('RESULT_UNKNOWN','Tool did not confirm a successful effect');
            if(Buffer.byteLength(JSON.stringify(value)??'null')>131072)fail('RESULT_UNKNOWN','Effect receipt needs an external artifact reference');
            const accepted=await this.control.transaction(async client=>{
                const current=await client.query("UPDATE work_action_attempts SET state='succeeded',data=data||$2::jsonb,updated_at=now() WHERE id=$1 AND state='running' AND EXISTS(SELECT 1 FROM tasks WHERE id=$3 AND state='running') RETURNING id",[admission.attemptId,JSON.stringify({receiptConfirmed:true}),request.taskId]);
                if(!current.rowCount){await client.query('UPDATE work_action_attempts SET data=data||$2::jsonb,updated_at=now() WHERE id=$1',[admission.attemptId,JSON.stringify({lateReceipt:value})]);await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)',[randomUUID(),'work.action_late_receipt',JSON.stringify({workId:request.workId,taskId:request.taskId,actionId:admission.actionId,attemptId:admission.attemptId})]);return false;}
                await client.query("UPDATE work_actions SET state='succeeded',data=data||$2::jsonb,updated_at=now() WHERE id=$1 AND state='running'",[admission.actionId,JSON.stringify({value})]);return true;
            });if(!accepted)fail('RESULT_UNKNOWN','A fenced executor may submit evidence but cannot replace a resolved action');return{value,reused:false,actionId:admission.actionId};
        }catch(error){
            const state=error instanceof ActionNotStartedError?'not_executed':'unknown';
            await this.control.transaction(async client=>{
                const data=JSON.stringify({error:{code:(error as any).code??'EFFECT_UNCERTAIN'}});
                await client.query("UPDATE work_actions SET state=$2,data=data||$3::jsonb,updated_at=now() WHERE id=$1 AND state='running' AND EXISTS(SELECT 1 FROM work_action_attempts WHERE id=$4 AND state='running')",[admission.actionId,state,data,admission.attemptId]);
                await client.query("UPDATE work_action_attempts SET state=$2,data=data||$3::jsonb,updated_at=now() WHERE id=$1 AND state='running'",[admission.attemptId,state,data]);
            });
            if(state==='unknown')throw new FrameworkError('RESULT_UNKNOWN','Action outcome requires verification; it will not be replayed');throw error;
        }
    }
}
