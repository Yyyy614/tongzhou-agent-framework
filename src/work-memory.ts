import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {FastifyInstance} from 'fastify';
import type {Framework} from './index.js';
import type {SourceOrigin} from './provenance.js';
import type {ResourceRef} from './resources.js';
import {contentHash,requireUuid} from './contracts.js';
import {authenticateRequest} from './console-auth.js';
import {fail} from './errors.js';

export interface WorkNoteItem{text:string;refs:ResourceRef[];}
export interface WorkNote {goal:string;decisions:WorkNoteItem[];blockers:WorkNoteItem[];nextSteps:WorkNoteItem[];artifacts:ResourceRef[];}
export interface WorkNoteWrite extends WorkNote{expectedRevision:number;idempotencyKey:string;}
const reference={type:'object',additionalProperties:false,required:['id','version'],properties:{id:{type:'string',format:'uuid'},version:{type:'integer',minimum:1}}};
const refs={type:'array',maxItems:16,items:reference};
const item={type:'object',additionalProperties:false,required:['text','refs'],properties:{text:{type:'string',minLength:1,maxLength:500},refs:{...refs,maxItems:8}}};
const items={type:'array',maxItems:12,items:item};
export const workNoteSchema={type:'object',additionalProperties:false,required:['expectedRevision','idempotencyKey','goal','decisions','blockers','nextSteps','artifacts'],properties:{expectedRevision:{type:'integer',minimum:0},idempotencyKey:{type:'string',minLength:1,maxLength:160},goal:{type:'string',maxLength:800},decisions:items,blockers:items,nextSteps:items,artifacts:refs}};

/** Work notes are revisioned private claims; confirmed execution state stays in A1/A2 tables. */
export class WorkMemory {
    constructor(readonly host:Framework){}
    async open(){await this.host.db.pool.query(`
      CREATE TABLE IF NOT EXISTS work_memory_versions(id uuid PRIMARY KEY,company_id text NOT NULL,work_id uuid NOT NULL,principal_id text NOT NULL,agent_id text NOT NULL,revision integer NOT NULL,data jsonb NOT NULL,dependencies jsonb NOT NULL,request_key text UNIQUE NOT NULL,input_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(work_id,principal_id,agent_id,revision));
      CREATE TABLE IF NOT EXISTS work_context_bindings(company_id text NOT NULL,principal_id text NOT NULL,agent_id text NOT NULL,entry_key text NOT NULL,work_id uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(principal_id,agent_id,entry_key));
    `);}
    private async authorize(principalId:string,workId:string,agentId:string,client:Pick<PoolClient,'query'>=this.host.db.pool){
        requireUuid(workId);const scope=await this.host.organization.authorizeAgent(principalId,agentId,'read',client);
        const work=(await client.query('SELECT * FROM work_items WHERE id=$1 AND company_id=$2',[workId,scope.actor.companyId])).rows[0];
        const assigned=work&&(await client.query('SELECT 1 FROM work_assignments WHERE work_id=$1 AND agent_id=$2 AND owner_id=$3 UNION ALL SELECT 1 FROM work_round_assignments WHERE work_id=$1 AND agent_id=$2 AND owner_id=$3',[workId,agentId,scope.agent.ownerId])).rowCount;
        if(!assigned)fail('NOT_FOUND','Work is unavailable for this job');
        return{...scope,work,own:scope.actor.id===scope.agent.ownerId};
    }
    private async latest(workId:string,agentId:string,ownerId:string,client:Pick<PoolClient,'query'>=this.host.db.pool){return(await client.query('SELECT * FROM work_memory_versions WHERE work_id=$1 AND agent_id=$2 AND principal_id=$3 ORDER BY revision DESC LIMIT 1',[workId,agentId,ownerId])).rows[0];}
    async read(principalId:string,workId:string,agentId:string){
        const {actor,agent,work,own}=await this.authorize(principalId,workId,agentId);
        const snapshot=await this.host.coordination?.snapshot(workId);
        if(!snapshot)fail('UNAVAILABLE','Work coordination is unavailable');
        const facts={state:snapshot.state,round:work.current_round,controlMode:work.control_mode,controlRevision:work.control_revision,origin:'host-confirmed',notice:'工作笔记不会改变审批、执行状态或动作回执。'};
        if(!own&&!actor.permissions.includes('work.memory.read:'+agent.id))return{workId,agentId,title:work.data.title,facts,note:null,revision:undefined,memoryRef:undefined,sourceAuthority:null,derivedValidity:'control-only',visibility:'control-only' as const,resultRefs:[]};
        const row=await this.latest(workId,agentId,agent.ownerId),sourceStatus=row?await this.host.provenance.status(actor.id,row.dependencies):{visible:true,current:true,fingerprint:null},allowed=sourceStatus.visible;
        const results=(await this.host.db.pool.query("SELECT t.id,t.state,r.process_ref FROM tasks t LEFT JOIN task_results r ON r.task_id=t.id WHERE t.agent_id=$1 AND t.data->>'workId'=$2 AND t.data->>'executionPrincipalId'=$3 ORDER BY t.created_at DESC LIMIT 8",[agent.id,workId,agent.ownerId])).rows;
        const resultRefs=[];for(const result of results){if(!result.process_ref)continue;try{const source=await this.host.resources.read(actor.id,result.process_ref.id,result.process_ref.version,0,1);if(source.derivedValidity==='current'&&source.freshness==='current')resultRefs.push({taskId:result.id,state:result.state,ref:source.resourceRef});}catch(error){if((error as any).code!=='NOT_FOUND')throw error;}}
        const note:WorkNote=allowed&&row?row.data:{goal:work.data.title,decisions:[],blockers:[],nextSteps:[],artifacts:[]};
        return{workId,agentId,title:work.data.title,facts,revision:row?.revision??0,note,visibility:allowed?'private-work-memory':'sources-unavailable',sourceAuthority:sourceStatus.fingerprint,derivedValidity:sourceStatus.current?'current':'source-changed',resultRefs,...(row?{memoryRef:{id:row.id,revision:row.revision},updatedAt:row.created_at}:{}),origin:'agent-reported'};
    }
    async save(principalId:string,workId:string,agentId:string,input:WorkNoteWrite,derivation?:SourceOrigin[],rebuild=false,expectedControlRevision?:number){
        if(!this.host.registry.ajv.validate(workNoteSchema,input)||JSON.stringify(input).length>16000)fail('INVALID_INPUT','Invalid bounded work note');
        const client=await this.host.db.pool.connect();
        try{await client.query('BEGIN');await this.host.organization.lock(client);const {actor,agent,own}=await this.authorize(principalId,workId,agentId,client);
            if(!own)fail('PERMISSION_DENIED','Only the execution owner edits private work notes');
            if(derivation){const work=(await client.query('SELECT control_mode,control_revision FROM work_items WHERE id=$1 FOR UPDATE',[workId])).rows[0];if(work?.control_mode!=='active'||expectedControlRevision!==undefined&&work.control_revision!==expectedControlRevision)fail('WORK_STOPPED','Work control changed before the automated note action');}
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[workId+':'+agentId+':'+actor.id]);
            const key=contentHash([actor.companyId,workId,agentId,actor.id,input.idempotencyKey]),hash=contentHash(rebuild?{input,mode:'rebuild'}:input);
            const prior=(await client.query('SELECT input_hash FROM work_memory_versions WHERE request_key=$1',[key])).rows[0];
            if(prior){if(prior.input_hash!==hash)fail('CONFLICT','Work note retry changed');await client.query('COMMIT');return this.read(principalId,workId,agentId);}
            const previous=await this.latest(workId,agentId,actor.id,client);
            if((previous?.revision??0)!==input.expectedRevision)fail('CONFLICT','Work note changed; reload before saving');
            if(rebuild){if(!previous||!derivation?.length||derivation.some(s=>s.kind==='work-memory'&&s.id===workId&&s.agentId===agentId))fail('PERMISSION_DENIED','Rebuild requires a fresh context without the old note');if((await this.host.provenance.status(actor.id,previous.dependencies,client)).current)fail('CONFLICT','Current work notes should be edited normally');}
            const sourceRefs=[...input.artifacts,...input.decisions.flatMap(i=>i.refs),...input.blockers.flatMap(i=>i.refs),...input.nextSteps.flatMap(i=>i.refs)];
            const sources:SourceOrigin[]=[...(rebuild?[]:previous?.dependencies??[]),...(derivation??[]),{kind:'input',id:'work-note:'+key,ownerId:actor.id,companyId:actor.companyId}];
            for(const ref of sourceRefs){const source=await this.host.resources.originStatus(actor.id,{kind:'resource',...ref},client);if(!source.visible)fail('NOT_FOUND','Work note reference is unavailable');sources.push(...await this.host.provenance.resourceOrigins({...ref,revision:source.revision},client));}
            const dependencies=this.host.provenance.unique(sources);if(dependencies.length>512)fail('CONTEXT_BUDGET_EXCEEDED','Work note source limit reached');
            const status=await this.host.provenance.status(actor.id,dependencies,client);if(!status.visible)fail('NOT_FOUND','Work note source is unavailable');if(rebuild&&!status.current)fail('CONFLICT','Rebuild requires current authorized evidence');
            const {expectedRevision,idempotencyKey,...note}=input,revision=expectedRevision+1;
            await client.query('INSERT INTO work_memory_versions(id,company_id,work_id,principal_id,agent_id,revision,data,dependencies,request_key,input_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),actor.companyId,workId,actor.id,agent.id,revision,JSON.stringify(note),JSON.stringify(dependencies),key,hash]);
            await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)',[randomUUID(),'work.memory_saved',JSON.stringify({companyId:actor.companyId,principalId:actor.id,agentId:agent.id,workId,revision})]);
            await client.query('COMMIT');return this.read(principalId,workId,agentId);
        }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }
    async bind(principalId:string,agentId:string,entryKey:string,workId:string){
        if(!entryKey?.trim()||entryKey.length>200)fail('INVALID_INPUT','Invalid work entry binding');
        const {actor,own}=await this.authorize(principalId,workId,agentId);if(!own)fail('PERMISSION_DENIED','Work binding belongs to its executor');
        await this.host.db.pool.query('INSERT INTO work_context_bindings(company_id,principal_id,agent_id,entry_key,work_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(principal_id,agent_id,entry_key) DO UPDATE SET work_id=EXCLUDED.work_id,updated_at=now()',[actor.companyId,actor.id,agentId,entryKey,workId]);
    }
    async unbind(principalId:string,agentId:string,entryKey:string){
        const {actor,agent}=await this.host.authorize(principalId,agentId);if(actor.id!==agent.ownerId)fail('PERMISSION_DENIED','Work binding belongs to its executor');
        await this.host.db.pool.query('DELETE FROM work_context_bindings WHERE principal_id=$1 AND agent_id=$2 AND entry_key=$3',[actor.id,agent.id,entryKey]);
    }
    async origin(principalId:string,workId:string,agentId:string){
        const {agent,own}=await this.authorize(principalId,workId,agentId);if(!own)fail('PERMISSION_DENIED','Work memory origin belongs to its executor');
        const row=await this.latest(workId,agentId,agent.ownerId);
        return row?{ref:{kind:'work-memory' as const,id:workId,agentId,version:row.revision,ownerId:agent.ownerId},sources:row.dependencies}:null;
    }
    async originStatus(principalId:string,source:SourceOrigin,client:Pick<PoolClient,'query'>=this.host.db.pool){
        try{
            const scope=await this.authorize(principalId,source.id,source.agentId!,client);
            if(!scope.own&&!scope.actor.permissions.includes('work.memory.read:'+scope.agent.id))return{visible:false,authority:null};
            if(scope.agent.ownerId!==source.ownerId)return{visible:false,authority:null};
            const version=(await client.query('SELECT id FROM work_memory_versions WHERE work_id=$1 AND agent_id=$2 AND principal_id=$3 AND revision=$4',[source.id,source.agentId,source.ownerId,source.version])).rows[0];
            return{visible:!!version,authority:contentHash({companyId:scope.actor.companyId,ownerId:scope.agent.ownerId,agentId:scope.agent.id,actor:scope.actor})};
        }catch(error){if(['PERMISSION_DENIED','NOT_FOUND'].includes((error as any).code))return{visible:false,authority:null};throw error;}
    }
    async compact(principalId:string,workId:string,agentId:string,maxChars=2800){
        const current=await this.read(principalId,workId,agentId),usable=current.visibility==='private-work-memory'&&current.derivedValidity==='current',note=usable?current.note:null;
        const value:any={workId,facts:current.facts,goal:note?.goal??current.title,sourceValidity:'derivedValidity' in current?current.derivedValidity:'control-only',decisions:[],blockers:[],nextSteps:[],artifacts:[],resultRefs:[],noteRef:usable?current.memoryRef??null:null,omissions:[],readMore:'/v1/work/'+workId+'/memory/'+agentId};
        const sections=(['decisions','blockers','nextSteps','artifacts','resultRefs'] as const).map(field=>({field,candidates:field==='resultRefs'?current.resultRefs:note?.[field]??[]}));
        value.omissions=sections.filter(s=>s.candidates.length).map(s=>({section:s.field,count:s.candidates.length,reason:'budget',continuation:value.readMore}));
        if(!usable&&current.memoryRef)value.omissions.push({section:'work-note',reason:'source-changed-or-unavailable',continuation:value.readMore});
        if(JSON.stringify(value).length>maxChars)fail('CONTEXT_BUDGET_EXCEEDED','Required work state and continuation references do not fit the memory budget');
        for(const {field,candidates} of sections){
            for(const item of candidates){const previous=structuredClone(value.omissions);value[field].push(item);const omitted=value.omissions.find((o:any)=>o.section===field);if(omitted&&!--omitted.count)value.omissions=value.omissions.filter((o:any)=>o!==omitted);if(JSON.stringify(value).length>maxChars){value[field].pop();value.omissions=previous;}}
        }
        await this.host.db.pool.query('INSERT INTO context_operations(id,company_id,principal_id,agent_id,work_id,kind,data) SELECT $1,data->>\'companyId\',$2,$3,$4,\'memory-compaction\',$5 FROM actors WHERE id=$2',[randomUUID(),principalId,agentId,workId,JSON.stringify({outputChars:JSON.stringify(value).length,omittedSections:value.omissions.length,modelCalls:0,inputTokens:0,outputTokens:0})]);
        return{text:JSON.stringify(value),included:usable&&!!current.memoryRef,ref:current.revision!==undefined?{workId,agentId,revision:current.revision,sourceAuthority:current.sourceAuthority??null,visibility:current.visibility}:null,resultRefs:value.resultRefs,omissions:value.omissions};
    }
    async recordResult(task:any,runId:string,processRef:ResourceRef){
        if(!task.data.workId)return;
        const owner=task.data.executionPrincipalId,workId=task.data.workId,agentId=task.agent_id;
        const sources=await this.host.provenance.snapshot(runId)??[{kind:'unknown' as const,id:runId,ownerId:owner}];
        if(!(await this.host.provenance.status(owner,sources)).visible)return;
        const current=await this.read(owner,workId,agentId);if(current.visibility!=='private-work-memory'||!current.note||current.revision===undefined)return;
        const artifacts=[processRef,...current.note.artifacts].filter((r,i,all)=>all.findIndex(a=>a.id===r.id&&a.version===r.version)===i).slice(0,16);
        try{await this.save(owner,workId,agentId,{...current.note,artifacts,expectedRevision:current.revision!,idempotencyKey:'result:'+runId},sources);}catch(error){if(!['CONFLICT','NOT_FOUND'].includes((error as any).code))throw error;await this.host.db.audit('work.memory_update_deferred',{principalId:owner,agentId,workId,runId});}
    }
    async requestRebuild(principalId:string,workId:string,agentId:string,input:{expectedRevision:number;idempotencyKey:string}){const{actor,own,work}=await this.authorize(principalId,workId,agentId);if(!own)fail('PERMISSION_DENIED','Only the execution owner can rebuild private notes');const current=await this.read(actor.id,workId,agentId);if(current.revision!==input.expectedRevision||current.derivedValidity==='current')fail('CONFLICT','Work note changed or is already current');if(work.control_mode!=='active')fail('CONFLICT','请先明确恢复工作，再重建笔记。');if(!this.host.coordination)fail('UNAVAILABLE','Task service unavailable');const previous=await this.latest(workId,agentId,actor.id),refs:ResourceRef[]=[];for(const origin of previous?.dependencies??[])if(refs.length<16&&origin.kind==='resource'&&!refs.some(r=>r.id===origin.id)){try{const r=await this.host.resources.read(actor.id,origin.id,undefined,0,1);if(r.freshness==='current'&&r.derivedValidity==='current')refs.push(r.resourceRef);}catch(e){if(!['NOT_FOUND','PERMISSION_DENIED'].includes((e as any).code))throw e;}}
        return this.host.coordination.queue.submit({principalId:actor.id,agentId,prompt:'基于当前有效证据重新整理这项工作的私人笔记。旧笔记未进入上下文，不要猜测旧内容。先读取下面仍可访问的新版来源或用 resource_recall 检索当前资料，再调用 work_memory_rebuild。保持目标清晰，只写有依据的决定、阻塞与下一步；缺资料时明确记为阻塞，不改变宿主执行/审批事实。expectedRevision='+input.expectedRevision+'；可核实的来源='+JSON.stringify(refs),idempotencyKey:'work-note-rebuild:'+workId+':'+input.idempotencyKey,contextWorkId:workId,workControlRevision:work.control_revision,executionProfile:'memory-maintenance'});
    }
    async resolve(principalId:string,agentId:string,input:{entryKey?:string;workId?:string;continueWork:boolean}){
        const {actor,agent}=await this.host.authorize(principalId,agentId);if(agent.ownerId!==actor.id)fail('PERMISSION_DENIED','Work resolution belongs to the executor');
        if(input.workId){await this.authorize(actor.id,input.workId,agent.id);if(input.entryKey)await this.bind(actor.id,agent.id,input.entryKey,input.workId);return{status:'resolved' as const,workId:input.workId};}
        if(input.entryKey){const bound=(await this.host.db.pool.query('SELECT work_id FROM work_context_bindings WHERE company_id=$1 AND principal_id=$2 AND agent_id=$3 AND entry_key=$4',[actor.companyId,actor.id,agent.id,input.entryKey])).rows[0];if(bound){await this.authorize(actor.id,bound.work_id,agent.id);return{status:'resolved' as const,workId:bound.work_id};}}
        if(!input.continueWork)return{status:'none' as const};
        const rows=(await this.host.db.pool.query(`SELECT w.id,w.data->>'title' AS title FROM work_items w WHERE w.company_id=$1 AND
          (EXISTS(SELECT 1 FROM work_assignments a WHERE a.work_id=w.id AND a.agent_id=$2 AND a.owner_id=$3) OR EXISTS(SELECT 1 FROM work_round_assignments a WHERE a.work_id=w.id AND a.agent_id=$2 AND a.owner_id=$3)) ORDER BY w.created_at DESC,w.id LIMIT 17`,[actor.companyId,agent.id,actor.id])).rows;
        if(rows.length===1)return{status:'resolved' as const,workId:rows[0].id};
        return{status:'choose' as const,candidates:rows.slice(0,16),limited:rows.length>16};
    }
    registerRoutes(app:FastifyInstance){
        app.get<{Params:{id:string;agentId:string}}>('/v1/work/:id/memory/:agentId',async req=>this.read((await authenticateRequest(this.host,req)).id,req.params.id,req.params.agentId));
        app.put<{Params:{id:string;agentId:string}}>('/v1/work/:id/memory/:agentId',{schema:{body:workNoteSchema}},async req=>this.save((await authenticateRequest(this.host,req)).id,req.params.id,req.params.agentId,req.body as WorkNoteWrite));
        app.post<{Params:{id:string;agentId:string}}>('/v1/work/:id/memory/:agentId/rebuild-request',{schema:{body:{type:'object',additionalProperties:false,required:['expectedRevision','idempotencyKey'],properties:{expectedRevision:{type:'integer',minimum:0},idempotencyKey:{type:'string',minLength:1,maxLength:100}}}}},async(req,reply)=>reply.code(202).send(await this.requestRebuild((await authenticateRequest(this.host,req)).id,req.params.id,req.params.agentId,req.body as any)));
        app.post<{Params:{agentId:string}}>('/v1/agents/:agentId/work-context',{schema:{body:{type:'object',additionalProperties:false,required:['continueWork'],properties:{continueWork:{type:'boolean'},entryKey:{type:'string',maxLength:200},workId:{type:'string',format:'uuid'}}}}},async req=>this.resolve((await authenticateRequest(this.host,req)).id,req.params.agentId,req.body as any));
    }
}
