import type{Framework}from'./index.js';import type{MemoryDomain,MemorySource}from'./knowledge.js';import{randomUUID}from'node:crypto';import{contentHash}from'./contracts.js';import{fail}from'./errors.js';
/** Opaque continuations bind a provider position to a live principal and authoritative change watermarks. */
export class SourceSearch{
 constructor(readonly host:Framework){}
 async open(){await this.host.db.pool.query('CREATE TABLE IF NOT EXISTS source_search_pages(id uuid PRIMARY KEY,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now())');}
 async authority(principalId:string){const actor=await this.host.db.get<any>('actors',principalId);if(!actor.active)fail('PERMISSION_DENIED','Inactive source reader');const water=(await this.host.db.pool.query(`SELECT
 (SELECT generation::text FROM authorization_generations WHERE company_id=$1) AS auth,
 (SELECT max(seq)::text FROM resource_change_outbox WHERE company_id=$1) AS resources,
 (SELECT count(*)::text||':'||coalesce(max(created_at)::text,'') FROM work_memory_versions WHERE company_id=$1) AS work,
 (SELECT coalesce(sum(m.version),0)::text FROM memories m JOIN agents a ON a.id=m.agent_id WHERE a.data->>'companyId'=$1) AS memory`,[actor.companyId])).rows[0];return contentHash([actor,water]);}
 async load(cursor:string){if(!/^[a-f0-9-]{36}$/iu.test(cursor))fail('CONFLICT','Invalid search continuation');const row=(await this.host.db.pool.query("SELECT data FROM source_search_pages WHERE id=$1 AND created_at>now()-interval '1 day'",[cursor])).rows[0];if(!row)fail('CONFLICT','Search continuation expired');return row.data;}
 async page(principalId:string,agentId:string,domain:MemoryDomain,query:string,source:MemorySource,limit:number,maxScans:number,cursor?:string,workId?:string){
  const {actor}=await this.host.authorize(principalId,agentId),authority=await this.authority(actor.id),version=source.indexVersion?await source.indexVersion(actor.id,domain.id):null,key=contentHash([actor.id,actor.companyId,agentId,domain.id,domain.revision,query,workId??null]);let position:string|undefined;
  if(cursor){const old=await this.load(cursor);if(old.key!==key||old.authority!==authority||old.version!==version)fail('CONFLICT','Search continuation changed; restart the query');position=old.position;}
  const found=await source.search(actor.id,domain.id,query,limit,{cursor:position,maxScans});
  if((await this.authority(actor.id))!==authority||(source.indexVersion&&await source.indexVersion(actor.id,domain.id)!==version))fail('CONFLICT','Source changed while searching');
  let nextCursor:string|null=null;const supported=version!==null&&found.nextCursor&&found.nextCursor!==position;
  if(found.hasMore&&supported){nextCursor=randomUUID();await this.host.db.pool.query('INSERT INTO source_search_pages(id,data) VALUES($1,$2)',[nextCursor,JSON.stringify({key,authority,version,position:found.nextCursor,domain:domain.id,query,principalId:actor.id,agentId,companyId:actor.companyId,workId:workId??null})]);}
  return{...found,nextCursor,limitation:found.hasMore&&!supported?'pagination-unsupported':found.hasMore?'candidate-page':null};
 }
}
