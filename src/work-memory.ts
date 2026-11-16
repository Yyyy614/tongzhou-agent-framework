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

export const organizeSchema={type:'object',additionalProperties:false,required:['expectedRevision','idempotencyKey','changes'],properties:{expectedRevision:{type:'integer',minimum:1},idempotencyKey:{type:'string',minLength:1,maxLength:160},changes:{type:'array',minItems:1,maxItems:16,items:{type:'object',additionalProperties:false,required:['section','index','reason'],properties:{section:{enum:['decisions','blockers','nextSteps']},index:{type:'integer',minimum:0,maximum:11},reason:{type:'string',minLength:1,maxLength:500}}}}}};
export interface NoteOrganization{expectedRevision:number;idempotencyKey:string;changes:Array<{section:'decisions'|'blockers'|'nextSteps';index:number;reason:string}>;}
/** Work notes are revisioned private claims; confirmed execution state stays in A1/A2 tables. */
export class WorkMemory {
    constructor(readonly host:Framework){}
    async open(){await this.host.db.pool.query(`
      CREATE TABLE IF NOT EXISTS work_memory_versions(id uuid PRIMARY KEY,company_id text NOT NULL,work_id uuid NOT NULL,principal_id text NOT NULL,agent_id text NOT NULL,revision integer NOT NULL,data jsonb NOT NULL,dependencies jsonb NOT NULL,request_key text UNIQUE NOT NULL,input_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(work_id,principal_id,agent_id,revision));
      CREATE TABLE IF NOT EXISTS work_context_bindings(company_id text NOT NULL,principal_id text NOT NULL,agent_id text NOT NULL,entry_key text NOT NULL,work_id uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(principal_id,agent_id,entry_key));
      ALTER TABLE work_memory_versions ADD COLUMN IF NOT EXISTS archived_items jsonb NOT NULL DEFAULT '[]';
      CREATE TABLE IF NOT EXISTS work_memory_source_bridges(note_id uuid PRIMARY KEY REFERENCES work_memory_versions(id),dependencies_hash text NOT NULL,source_ref jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS work_memory_pages(id uuid PRIMARY KEY,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE work_memory_versions ADD COLUMN IF NOT EXISTS lineage_refs jsonb NOT NULL DEFAULT '[]';
      ALTER TABLE work_memory_versions ADD COLUMN IF NOT EXISTS written_by_run text;
    `);}
    private async authorize(principalId:string,workId:string,agentId:string,client:Pick<PoolClient,'query'>=this.host.db.pool){
        requireUuid(workId);const scope=await this.host.organization.authorizeAgent(principalId,agentId,'read',client);
        const work=(await client.query('SELECT * FROM work_items WHERE id=$1 AND company_id=$2',[workId,scope.actor.companyId])).rows[0];
        const assigned=work&&(await client.query('SELECT 1 FROM work_assignments WHERE work_id=$1 AND agent_id=$2 AND owner_id=$3 UNION ALL SELECT 1 FROM work_round_assignments WHERE work_id=$1 AND agent_id=$2 AND owner_id=$3',[workId,agentId,scope.agent.ownerId])).rowCount;
        if(!assigned)fail('NOT_FOUND','Work is unavailable for this job');
        return{...scope,work,own:scope.actor.id===scope.agent.ownerId};
    }
    private async latest(workId:string,agentId:string,ownerId:string,client:Pick<PoolClient,'query'>=this.host.db.pool){return(await client.query('SELECT * FROM work_memory_versions WHERE work_id=$1 AND agent_id=$2 AND principal_id=$3 ORDER BY revision DESC LIMIT 1',[workId,agentId,ownerId])).rows[0];}
    async read(principalId:string,workId:string,agentId:string,revision?:number){
        if(revision!==undefined&&(!Number.isInteger(revision)||revision<1))fail('INVALID_INPUT','Invalid work memory revision');
        const {actor,agent,work,own}=await this.authorize(principalId,workId,agentId);
        const snapshot=await this.host.coordination?.snapshot(workId);
        if(!snapshot)fail('UNAVAILABLE','Work coordination is unavailable');
        const facts={state:snapshot.state,round:work.current_round,controlMode:work.control_mode,controlRevision:work.control_revision,origin:'host-confirmed',notice:'工作笔记不会改变审批、执行状态或动作回执。'};
        if(!own&&!actor.permissions.includes('work.memory.read:'+agent.id))return{workId,agentId,title:work.data.title,facts,note:null,revision:undefined,memoryRef:undefined,sourceAuthority:null,derivedValidity:'control-only',visibility:'control-only' as const,currentRevision:undefined,sourceCollectionRef:null,archives:[],resultRefs:[]};
        const latest=await this.latest(workId,agentId,agent.ownerId),row=revision?(await this.host.db.pool.query('SELECT * FROM work_memory_versions WHERE work_id=$1 AND agent_id=$2 AND principal_id=$3 AND revision=$4',[workId,agentId,agent.ownerId,revision])).rows[0]:latest;
        if(revision&&!row)fail('NOT_FOUND','Work memory revision unavailable');
        const sourceStatus=row?await this.host.provenance.status(actor.id,row.dependencies.length?row.dependencies:[{kind:'unknown',id:row.id,ownerId:row.principal_id,companyId:row.company_id}]):{visible:true,current:true,fingerprint:null},allowed=sourceStatus.visible&&sourceStatus.verified!==false;
        const results=(await this.host.db.pool.query("SELECT t.id,t.state,r.process_ref FROM tasks t LEFT JOIN task_results r ON r.task_id=t.id WHERE t.agent_id=$1 AND t.data->>'workId'=$2 AND t.data->>'executionPrincipalId'=$3 ORDER BY t.created_at DESC LIMIT 8",[agent.id,workId,agent.ownerId])).rows;
        const resultRefs=[];for(const result of results){if(!result.process_ref)continue;try{const source=await this.host.resources.read(actor.id,result.process_ref.id,result.process_ref.version,0,1);if(source.derivedValidity==='current'&&source.freshness==='current')resultRefs.push({taskId:result.id,state:result.state,ref:source.resourceRef});}catch(error){if((error as any).code!=='NOT_FOUND')throw error;}}
        const bridge=allowed&&row&&!(row.dependencies.length===1&&row.dependencies[0].kind==='source-set')?(await this.host.db.pool.query('SELECT * FROM work_memory_source_bridges WHERE note_id=$1',[row.id])).rows[0]:null;const collectionRef=allowed&&row?.dependencies?.length===1&&row.dependencies[0].kind==='source-set'?{id:row.dependencies[0].id,version:1}:bridge&&bridge.dependencies_hash===contentHash(row.dependencies)?{id:bridge.source_ref.id,version:1}:null;
        const note:WorkNote=allowed&&row?row.data:{goal:work.data.title,decisions:[],blockers:[],nextSteps:[],artifacts:[]};
        return{workId,agentId,title:work.data.title,facts,revision:row?.revision??0,currentRevision:latest?.revision??0,sourceCollectionRef:collectionRef,lineageRefs:allowed?row?.lineage_refs??[]:[],archives:allowed?row?.archived_items??[]:[],note,visibility:allowed?'private-work-memory':'sources-unavailable',sourceAuthority:sourceStatus.fingerprint,sourceVerification:sourceStatus.verified===false?'required':'verified',derivedValidity:sourceStatus.current&&(!row||row.revision===latest?.revision)?'current':'source-changed',resultRefs,...(row?{memoryRef:{id:row.id,revision:row.revision},updatedAt:row.created_at}:{}),origin:'agent-reported'};
    }
    private async revisionSources(client:PoolClient,sources:SourceOrigin[],scope:{workId:string;agentId:string;ownerId:string;nextRevision:number},lineage:SourceOrigin[]=[],path:Set<number>=new Set()):Promise<{sources:SourceOrigin[];lineage:SourceOrigin[]}>{
        const active:SourceOrigin[]=[];
        for(const source of sources){
            if(source.kind!=='work-memory'||source.id!==scope.workId||source.agentId!==scope.agentId||source.ownerId!==scope.ownerId){active.push(source);continue;}
            const revision=source.version!;if(!Number.isInteger(revision)||revision>=scope.nextRevision||path.has(revision)||path.size>=64)fail('CONFLICT','Work revision ancestry requires verification');
            const previous=(await client.query('SELECT dependencies,principal_id,id FROM work_memory_versions WHERE work_id=$1 AND agent_id=$2 AND principal_id=$3 AND revision=$4',[scope.workId,scope.agentId,scope.ownerId,revision])).rows[0];if(!previous)fail('NOT_FOUND','Revision ancestry unavailable');
            lineage.push({...source,relation:'revision-history'});
            const nested=await this.revisionSources(client,previous.dependencies.length?previous.dependencies:[{kind:'unknown',id:source.id,ownerId:scope.ownerId}],{...scope,nextRevision:revision},lineage,new Set([...path,revision]));active.push(...(nested.sources.length===1&&nested.sources[0]!.kind==='source-set'?nested.sources:nested.sources.length?[await this.host.provenance.collections.write(scope.ownerId,scope.agentId,nested.sources,client)]:[]));
        }
        return{sources:this.host.provenance.unique(active),lineage:this.host.provenance.unique(lineage)};
    }
    async save(principalId:string,workId:string,agentId:string,input:WorkNoteWrite,derivation?:SourceOrigin[],rebuild=false,expectedControlRevision?:number,runId?:string,organization?:{archives:any[]}){
        if(!this.host.registry.ajv.validate(workNoteSchema,input)||JSON.stringify(input).length>16000)fail('INVALID_INPUT','Invalid bounded work note');
        const client=await this.host.db.pool.connect();
        try{await client.query('BEGIN');await this.host.organization.lock(client);const {actor,agent,own}=await this.authorize(principalId,workId,agentId,client);
            if(!own)fail('PERMISSION_DENIED','Only the execution owner edits private work notes');
            if(derivation){const work=(await client.query('SELECT control_mode,control_revision FROM work_items WHERE id=$1 FOR UPDATE',[workId])).rows[0];if(work?.control_mode!=='active'||expectedControlRevision!==undefined&&work.control_revision!==expectedControlRevision)fail('WORK_STOPPED','Work control changed before the automated note action');}
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[workId+':'+agentId+':'+actor.id]);
            const key=contentHash([actor.companyId,workId,agentId,actor.id,input.idempotencyKey]),hash=contentHash(organization?{input,mode:'organize',archives:organization.archives}:rebuild?{input,mode:'rebuild'}:input);
            const prior=(await client.query('SELECT input_hash,revision FROM work_memory_versions WHERE request_key=$1',[key])).rows[0];
            if(prior){if(prior.input_hash!==hash)fail('CONFLICT','Work note retry changed');await client.query('COMMIT');return this.read(principalId,workId,agentId,prior.revision);}
            const previous=await this.latest(workId,agentId,actor.id,client);
            if((previous?.revision??0)!==input.expectedRevision)fail('CONFLICT','Work note changed; reload before saving');
            if(rebuild){if(!previous||!derivation?.length||derivation.some(s=>s.kind==='work-memory'&&s.id===workId&&s.agentId===agentId))fail('PERMISSION_DENIED','Rebuild requires a fresh context without the old note');if((await this.host.provenance.status(actor.id,previous.dependencies.length?previous.dependencies:[{kind:'unknown',id:previous.id,ownerId:actor.id}],client)).current)fail('CONFLICT','Current work notes should be edited normally');}
            const sourceRefs=[...input.artifacts,...input.decisions.flatMap(i=>i.refs),...input.blockers.flatMap(i=>i.refs),...input.nextSteps.flatMap(i=>i.refs)];
            let inherited:SourceOrigin[]=rebuild||!previous?[]:previous.dependencies.length?previous.dependencies:[{kind:'unknown',id:previous.id,ownerId:actor.id,companyId:actor.companyId}];if(inherited.length&&!(inherited.length===1&&inherited[0]!.kind==='source-set')){const normalized=await this.revisionSources(client,inherited,{workId,agentId,ownerId:actor.id,nextRevision:input.expectedRevision+1});inherited=[await this.host.provenance.collections.write(actor.id,agent.id,normalized.sources,client)];}
            const sources:SourceOrigin[]=[...inherited,...(derivation??[]),{kind:'input',id:'work-note:'+key,ownerId:actor.id,companyId:actor.companyId}];
            for(const ref of sourceRefs){const source=await this.host.resources.originStatus(actor.id,{kind:'resource',...ref},client);if(!source.visible)fail('NOT_FOUND','Work note reference is unavailable');sources.push(...await this.host.provenance.resourceOrigins({...ref,revision:source.revision},client));}
            const normalized=await this.revisionSources(client,sources,{workId,agentId,ownerId:actor.id,nextRevision:input.expectedRevision+1}),dependencies=normalized.sources;if(dependencies.length>512)fail('CONTEXT_BUDGET_EXCEEDED','Work note source delta limit reached');
            const status=await this.host.provenance.status(actor.id,dependencies,client);if(!status.visible||status.verified===false)fail('NOT_FOUND','Work note source requires verification');if(rebuild&&!status.current)fail('CONFLICT','Rebuild requires current authorized evidence');
            const {expectedRevision,idempotencyKey,...note}=input,revision=expectedRevision+1;
            const lineage=this.host.provenance.unique([...(previous?[{kind:'work-memory' as const,id:workId,agentId,ownerId:actor.id,version:previous.revision,relation:'revision-history' as const}]:[]),...normalized.lineage]);
            await client.query('INSERT INTO work_memory_versions(id,company_id,work_id,principal_id,agent_id,revision,data,dependencies,request_key,input_hash,lineage_refs,written_by_run,archived_items) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[randomUUID(),actor.companyId,workId,actor.id,agent.id,revision,JSON.stringify(note),JSON.stringify([await this.host.provenance.collections.write(actor.id,agent.id,dependencies,client)]),key,hash,JSON.stringify(lineage),runId??null,JSON.stringify(organization?.archives??[])]);
            await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)',[randomUUID(),'work.memory_saved',JSON.stringify({companyId:actor.companyId,principalId:actor.id,agentId:agent.id,workId,revision})]);
            await client.query('COMMIT');return this.read(principalId,workId,agentId,revision);
        }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }
    async organize(principalId:string,workId:string,agentId:string,input:NoteOrganization,derivation?:SourceOrigin[],expectedControlRevision?:number,runId?:string){
        if(!this.host.registry.ajv.validate(organizeSchema,input))fail('INVALID_INPUT','Choose bounded note items and archival reasons');const current=await this.read(principalId,workId,agentId,input.expectedRevision);if(current.visibility!=='private-work-memory')fail('NOT_FOUND','Work memory unavailable');const note=structuredClone(current.note),keys=new Set<string>(),archives=[];
        for(const change of input.changes){const key=change.section+':'+change.index;if(keys.has(key)||!note[change.section][change.index])fail('INVALID_INPUT','Archive selection changed or is duplicated');keys.add(key);archives.push({...change,item:note[change.section][change.index],fromRevision:input.expectedRevision});}
        for(const section of ['decisions','blockers','nextSteps'] as const)note[section]=note[section].filter((_,index)=>!keys.has(section+':'+index));
        return this.save(principalId,workId,agentId,{...note,expectedRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey},derivation,false,expectedControlRevision,runId,{archives});
    }
    async history(principalId:string,workId:string,agentId:string,input:{limit?:number;cursor?:string}){const limit=input.limit??20;if(!Number.isInteger(limit)||limit<1||limit>50)fail('INVALID_INPUT','Invalid history page');const{actor,agent,own}=await this.authorize(principalId,workId,agentId);if(!own&&!actor.permissions.includes('work.memory.read:'+agent.id))fail('NOT_FOUND','Private work history unavailable');const head=await this.read(actor.id,workId,agentId),key=contentHash([actor,workId,agentId,head.currentRevision,head.sourceAuthority,await this.host.resourceIndex.authorizationGeneration(actor.companyId)]);let before=2147483647;
        if(input.cursor){requireUuid(input.cursor);const page=(await this.host.db.pool.query("SELECT data FROM work_memory_pages WHERE id=$1 AND created_at>now()-interval '1 day'",[input.cursor])).rows[0]?.data;if(!page||page.key!==key)fail('CONFLICT','Work history continuation changed');before=page.before;}
        const rows=(await this.host.db.pool.query('SELECT revision,created_at FROM work_memory_versions WHERE work_id=$1 AND principal_id=$2 AND agent_id=$3 AND revision<$4 ORDER BY revision DESC LIMIT $5',[workId,agent.ownerId,agentId,before,limit+1])).rows,items=[];for(const row of rows.slice(0,limit)){const value=await this.read(actor.id,workId,agentId,row.revision);items.push({revision:row.revision,currentRevision:head.currentRevision,createdAt:row.created_at,visibility:value.visibility,validity:value.derivedValidity,archives:value.archives??[],continuation:'/v1/work/'+workId+'/memory/'+agentId+'?revision='+row.revision});}
        let nextCursor:string|null=null;if(rows.length>limit){nextCursor=randomUUID();await this.host.db.pool.query('INSERT INTO work_memory_pages(id,data) VALUES($1,$2)',[nextCursor,JSON.stringify({key,before:items.at(-1)!.revision})]);}return{items,nextCursor,currentRevision:head.currentRevision};
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
    async origin(principalId:string,workId:string,agentId:string,revision?:number,historical=false){
        const client=await this.host.db.pool.connect();try{await client.query('BEGIN');await this.host.organization.lock(client);const{actor,agent,own}=await this.authorize(principalId,workId,agentId,client);if(!own)fail('PERMISSION_DENIED','Work memory origin belongs to its executor');
            const row=revision?(await client.query('SELECT * FROM work_memory_versions WHERE work_id=$1 AND agent_id=$2 AND principal_id=$3 AND revision=$4',[workId,agentId,agent.ownerId,revision])).rows[0]:await this.latest(workId,agentId,agent.ownerId,client);if(!row){await client.query('COMMIT');return null;}
            let sources:SourceOrigin[]=row.dependencies.length?row.dependencies:[{kind:'unknown',id:row.id,ownerId:actor.id,companyId:actor.companyId}];
            if(!(sources.length===1&&sources[0]!.kind==='source-set')){const hash=contentHash(row.dependencies),bridge=(await client.query('SELECT * FROM work_memory_source_bridges WHERE note_id=$1',[row.id])).rows[0];if(bridge&&bridge.dependencies_hash!==hash)fail('CONFLICT','Legacy source bridge requires verification');if(bridge)sources=[bridge.source_ref];else{const normalized=await this.revisionSources(client,sources,{workId,agentId,ownerId:actor.id,nextRevision:row.revision+1}),ref=await this.host.provenance.collections.write(actor.id,agent.id,normalized.sources,client);await client.query('INSERT INTO work_memory_source_bridges(note_id,dependencies_hash,source_ref) VALUES($1,$2,$3)',[row.id,hash,JSON.stringify(ref)]);sources=[ref];}}
            await client.query('COMMIT');return{ref:{kind:'work-memory' as const,id:workId,agentId,version:row.revision,ownerId:agent.ownerId,...(historical?{relation:'revision-history' as const}:{})},sources};
        }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }
    async originStatus(principalId:string,source:SourceOrigin,client:Pick<PoolClient,'query'>=this.host.db.pool):Promise<{visible:boolean;current?:boolean;referencedRevision?:number;currentRevision?:number|null;dependencies?:SourceOrigin[];authority:string|null}>{
        try{
            const scope=await this.authorize(principalId,source.id,source.agentId!,client);
            if(!scope.own&&!scope.actor.permissions.includes('work.memory.read:'+scope.agent.id))return{visible:false,authority:null};
            if(scope.agent.ownerId!==source.ownerId)return{visible:false,authority:null};
            const version=(await client.query('SELECT dependencies,principal_id,id FROM work_memory_versions WHERE work_id=$1 AND agent_id=$2 AND principal_id=$3 AND revision=$4',[source.id,source.agentId,source.ownerId,source.version])).rows[0],latest=await this.latest(source.id,source.agentId!,source.ownerId!,client);
            return{visible:!!version,current:!!version&&latest?.revision===source.version,referencedRevision:source.version,currentRevision:latest?.revision??null,dependencies:version?(version.dependencies.length?version.dependencies:[{kind:'unknown',id:version.id,ownerId:version.principal_id}]):undefined,authority:contentHash({companyId:scope.actor.companyId,ownerId:scope.agent.ownerId,agentId:scope.agent.id,actor:scope.actor,referencedRevision:source.version,currentRevision:latest?.revision??null})};
        }catch(error){if(['PERMISSION_DENIED','NOT_FOUND'].includes((error as any).code))return{visible:false,authority:null};throw error;}
    }
    async compact(principalId:string,workId:string,agentId:string,maxChars=2800,revision?:number){
        const current=await this.read(principalId,workId,agentId,revision),usable=current.visibility==='private-work-memory'&&(revision!==undefined||current.derivedValidity==='current'),note=usable?current.note:null;
        const value:any={workId,facts:current.facts,goal:note?.goal??current.title,sourceValidity:'derivedValidity' in current?current.derivedValidity:'control-only',decisions:[],blockers:[],nextSteps:[],artifacts:[],resultRefs:[],noteRef:usable?current.memoryRef??null:null,historical:revision!==undefined,sourceCollectionRef:usable?current.sourceCollectionRef:null,historyRead:{tool:'work_memory_history',oldestRevision:1},notice:revision!==undefined?'这是历史修订，仅供追溯；当前决定以最新修订为准。':'当前工作笔记',omissions:[],readMore:'/v1/work/'+workId+'/memory/'+agentId};
        const sections=(['decisions','blockers','nextSteps','artifacts','resultRefs'] as const).map(field=>({field,candidates:field==='resultRefs'?current.resultRefs:note?.[field]??[]}));
        value.omissions=sections.filter(s=>s.candidates.length).map(s=>({section:s.field,count:s.candidates.length,reason:'budget',continuation:value.readMore}));
        if(!usable&&current.memoryRef)value.omissions.push({section:'work-note',reason:'source-changed-or-unavailable',continuation:value.readMore});
        if(JSON.stringify(value).length>maxChars)fail('CONTEXT_BUDGET_EXCEEDED','Required work state and continuation references do not fit the memory budget');
        for(let index=0;index<Math.max(0,...sections.map(s=>s.candidates.length));index++){
            for(const {field,candidates} of sections){const item=candidates[index];if(item===undefined)continue;const previous=structuredClone(value.omissions);value[field].push(item);const omitted=value.omissions.find((o:any)=>o.section===field);if(omitted&&!--omitted.count)value.omissions=value.omissions.filter((o:any)=>o!==omitted);if(JSON.stringify(value).length>maxChars){value[field].pop();value.omissions=previous;}}
        }
        await this.host.db.pool.query('INSERT INTO context_operations(id,company_id,principal_id,agent_id,work_id,kind,data) SELECT $1,data->>\'companyId\',$2,$3,$4,\'memory-compaction\',$5 FROM actors WHERE id=$2',[randomUUID(),principalId,agentId,workId,JSON.stringify({outputChars:JSON.stringify(value).length,omittedSections:value.omissions.length,modelCalls:0,inputTokens:0,outputTokens:0})]);
        return{text:JSON.stringify(value),included:usable&&!!current.memoryRef,ref:current.revision!==undefined?{workId,agentId,revision:current.revision,sourceAuthority:current.sourceAuthority??null,visibility:current.visibility}:null,resultRefs:value.resultRefs,omissions:value.omissions};
    }
    async recordResult(task:any,runId:string,processRef:ResourceRef){
        if(!task.data.workId)return;
        // Results are host facts already stored in task_results and projected by read().
        // Attaching a completed result must not supersede the note that produced it.
        await this.host.db.audit('work.memory_result_linked',{principalId:task.data.executionPrincipalId,agentId:task.agent_id,workId:task.data.workId,taskId:task.id,runId,processRef});
    }
    async requestRebuild(principalId:string,workId:string,agentId:string,input:{expectedRevision:number;idempotencyKey:string}){const{actor,own,work}=await this.authorize(principalId,workId,agentId);if(!own)fail('PERMISSION_DENIED','Only the execution owner can rebuild private notes');const current=await this.read(actor.id,workId,agentId);if(current.revision!==input.expectedRevision||current.derivedValidity==='current')fail('CONFLICT','Work note changed or is already current');if(work.control_mode!=='active')fail('CONFLICT','请先明确恢复工作，再重建笔记。');if(!this.host.coordination)fail('UNAVAILABLE','Task service unavailable');const previous=await this.latest(workId,agentId,actor.id),refs:ResourceRef[]=[],origins:SourceOrigin[]=[];for(const source of previous?.dependencies??[]){if(source.kind==='source-set'){try{origins.push(...(await this.host.provenance.collections.resolve(source)).sources);}catch(error){if(!['NOT_FOUND','CONTEXT_BUDGET_EXCEEDED'].includes((error as any).code))throw error;}}else origins.push(source);}for(const origin of origins)if(refs.length<16&&origin.kind==='resource'&&!refs.some(r=>r.id===origin.id)){try{const r=await this.host.resources.read(actor.id,origin.id,undefined,0,1);if(r.freshness==='current'&&r.derivedValidity==='current')refs.push(r.resourceRef);}catch(e){if(!['NOT_FOUND','PERMISSION_DENIED'].includes((e as any).code))throw e;}}
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
        app.post<{Params:{id:string;agentId:string}}>('/v1/work/:id/memory/:agentId/organize',{schema:{body:organizeSchema}},async req=>this.organize((await authenticateRequest(this.host,req)).id,req.params.id,req.params.agentId,req.body as NoteOrganization));
        app.get<{Params:{id:string;agentId:string};Querystring:{cursor?:string;limit?:number}}>('/v1/work/:id/memory/:agentId/history',{schema:{querystring:{type:'object',additionalProperties:false,properties:{cursor:{type:'string',format:'uuid'},limit:{type:'integer',minimum:1,maximum:50}}}}},async req=>this.history((await authenticateRequest(this.host,req)).id,req.params.id,req.params.agentId,req.query));

        app.get<{Params:{id:string;agentId:string};Querystring:{revision?:number}}>('/v1/work/:id/memory/:agentId',{schema:{querystring:{type:'object',additionalProperties:false,properties:{revision:{type:'integer',minimum:1}}}}},async req=>this.read((await authenticateRequest(this.host,req)).id,req.params.id,req.params.agentId,req.query.revision));
        app.put<{Params:{id:string;agentId:string}}>('/v1/work/:id/memory/:agentId',{schema:{body:workNoteSchema}},async req=>this.save((await authenticateRequest(this.host,req)).id,req.params.id,req.params.agentId,req.body as WorkNoteWrite));
        app.post<{Params:{id:string;agentId:string}}>('/v1/work/:id/memory/:agentId/rebuild-request',{schema:{body:{type:'object',additionalProperties:false,required:['expectedRevision','idempotencyKey'],properties:{expectedRevision:{type:'integer',minimum:0},idempotencyKey:{type:'string',minLength:1,maxLength:100}}}}},async(req,reply)=>reply.code(202).send(await this.requestRebuild((await authenticateRequest(this.host,req)).id,req.params.id,req.params.agentId,req.body as any)));
        app.post<{Params:{agentId:string}}>('/v1/agents/:agentId/work-context',{schema:{body:{type:'object',additionalProperties:false,required:['continueWork'],properties:{continueWork:{type:'boolean'},entryKey:{type:'string',maxLength:200},workId:{type:'string',format:'uuid'}}}}},async req=>this.resolve((await authenticateRequest(this.host,req)).id,req.params.agentId,req.body as any));
    }
}
