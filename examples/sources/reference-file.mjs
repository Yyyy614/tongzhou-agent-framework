import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';
/** File indexes contain references only. Grants and all returned content are checked in the host. */
export function referenceFileSource(host,indexFile){
 const digest=text=>createHash('sha256').update(text).digest('hex');
 return{
  async indexVersion(){return digest(await readFile(indexFile,'utf8'));},
  async search(principalId,domain,query,limit,page={}){
   const text=await readFile(indexFile,'utf8'),data=JSON.parse(text);if(!Array.isArray(data)||data.length>10000)throw Error('Invalid source index');
   const actor=await host.db.get('actors',principalId),stamp=digest(JSON.stringify([principalId,actor.companyId,domain,query,digest(text),await host.knowledge.searchAuthority(principalId)]));
   let offset=0;if(page.cursor){const prior=JSON.parse(Buffer.from(page.cursor,'base64url').toString('utf8'));if(prior.stamp!==stamp||!Number.isInteger(prior.offset)||prior.offset<0||prior.offset>data.length)throw Error('Source continuation changed');offset=prior.offset;}
   const refs=[];let scanned=0;const maxScans=page.maxScans??256;
   while(offset<data.length&&scanned<maxScans&&refs.length<limit){const row=data[offset++];scanned++;if(row.domain!==domain||!String(row.searchText??'').toLowerCase().includes(query.toLowerCase()))continue;
    try{await host.resources.read(principalId,row.id,row.version,0,1);refs.push({id:row.id,version:row.version});}catch(e){if(!['NOT_FOUND','PERMISSION_DENIED'].includes(e.code))throw e;}
   }
   // An unfinished scan is an unknown coverage boundary, never a hidden-result count.
   return{refs,scanned,hasMore:offset<data.length,nextCursor:offset<data.length?Buffer.from(JSON.stringify({stamp,offset})).toString('base64url'):null};
  },
  read:(principalId,ref,query,limit)=>host.resources.snippet(principalId,ref,query,limit),
  async version(principalId,ref){const r=await host.resources.read(principalId,ref.id,ref.version,0,1);return{version:r.currentVersion,revision:r.revision};}
 };
}
