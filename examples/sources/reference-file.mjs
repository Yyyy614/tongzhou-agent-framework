import{readFile}from'node:fs/promises';
/** Host-side file index adapter. Content and grants always come from canonical host resources. */
export function referenceFileSource(host,indexFile){
 return{
  async search(principalId,domain,query,limit){const data=JSON.parse(await readFile(indexFile,'utf8'));if(!Array.isArray(data)||data.length>10000)throw Error('Invalid source index');const matches=data.filter(r=>r.domain===domain&&String(r.searchText??'').toLowerCase().includes(query.toLowerCase()));return{refs:matches.slice(0,limit).map(r=>({id:r.id,version:r.version})),hasMore:matches.length>limit};},
  read:(principalId,ref,query,limit)=>host.resources.snippet(principalId,ref,query,limit),
  async version(principalId,ref){const r=await host.resources.read(principalId,ref.id,ref.version,0,1);return{version:r.currentVersion,revision:r.revision};}
 };
}
