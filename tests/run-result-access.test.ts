import {test,expect} from 'vitest';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createFramework} from '../src/index.js';
import {createServer} from '../src/server.js';
import {HarnessRuntime} from '../src/runtime.js';

// Completed synthetic runs exercise the public read boundary; no provider is called.
async function fixture(){
 await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/run-result-access-')),resourceWorker:false}),app=await createServer(host),runtime=new HarnessRuntime(app,host,{apiKey:'fixture',upstreamURL:'http://127.0.0.1:1'});
 await host.installPlugin(resolve('fixtures/conformance-plugin'));
 for(const[id,companyId,role,permissions]of[['admin','one','admin',[]],['alice','one','employee',[]],['bob','one','employee',['agent.read:job']],['outsider','two','admin',[]]]as const)await host.putActor({id,companyId,role,permissions:[...permissions]});
 await host.putAgent({id:'job',ownerId:'alice',companyId:'one',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});
 const source=await host.resources.create('admin',{title:'Revocable source',domain:'guides',kind:'document',body:'Original evidence',access:{scope:'personal',readerIds:['alice']},idempotencyKey:'source'});
 async function run(ledger=true){const id=randomUUID(),marker='DERIVED-'+id;await host.db.pool.query('INSERT INTO runs(id,agent_id,principal_id,state,data,request_key) VALUES($1,$2,$3,$4,$5,$6)',[id,'job','alice','succeeded',JSON.stringify({resultFormat:'references-v1',output:marker,report:{facts:[{text:marker,refs:[{id:source.id,version:1}]}],artifacts:[],issues:[]},summary:marker}),id]);if(ledger)await host.provenance.add(id,'alice','job',await host.provenance.resourceOrigins(source));return{id,marker};}
 const read=async(id:string,principalId='alice')=>app.inject({url:'/v1/runs/'+id,headers:{authorization:'Bearer '+await host.issueAccessToken(principalId)}});
 return{host,app,source,run,read,close:async()=>{await runtime.close();await app.close();await host.close();}};
}
test('a no-task run hides every derived result field after source revocation while preserving its control state',async()=>{const f=await fixture();try{const r=await f.run();expect((await f.read(r.id)).json().output).toBe(r.marker);await f.host.resources.update('admin',f.source.id,{revision:f.source.revision,access:{scope:'personal',readerIds:[]}});const response=await f.read(r.id);expect(response.statusCode).toBe(200);expect(response.body).not.toContain(r.marker);expect(response.json()).toMatchObject({state:'succeeded',contentAccess:{visibility:'restricted'}});expect((await f.host.db.pool.query('SELECT data FROM runs WHERE id=$1',[r.id])).rows[0].data.output).toBe(r.marker);}finally{await f.close();}});
test('unknown legacy sources remain restricted and cross-owner identifiers never grant run bodies',async()=>{const f=await fixture();try{const old=await f.run(false);for(const actor of ['alice','admin','bob']){const response=await f.read(old.id,actor);expect(response.statusCode).toBe(200);expect(response.body).not.toContain(old.marker);expect(response.json().contentAccess.visibility).toBe('unknown');}expect((await f.read(old.id,'outsider')).statusCode).toBe(403);}finally{await f.close();}});
test('authorized historical results are explicitly stale and not returned as a current summary',async()=>{const f=await fixture();try{const r=await f.run();await f.host.resources.update('admin',f.source.id,{revision:f.source.revision,body:'Replacement evidence'});const response=await f.read(r.id);expect(response.statusCode).toBe(200);expect(response.json().output).toBe(r.marker);expect(response.json().contentAccess).toMatchObject({visibility:'authorized',validity:'source-changed'});expect(response.json().summary).toBeUndefined();}finally{await f.close();}});
