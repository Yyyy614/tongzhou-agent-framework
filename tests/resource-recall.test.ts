import {test,expect} from 'vitest';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createFramework} from '../src/index.js';
import {createServer} from '../src/server.js';

test('authorized query results are not displaced or counted by newer unrelated private records',async()=>{
    await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/recall-'))}),app=await createServer(host);
    try{
        for(const id of ['alice','bob'])await host.putActor({id,companyId:'one',role:'employee',permissions:[]});
        const own=await host.resources.create('alice',{title:'Earlier relevant record',domain:'reference',kind:'document',body:'necessary-evidence',access:{scope:'personal',readerIds:[]},idempotencyKey:'earlier'});
        await host.db.pool.query(`WITH inserted AS (
          INSERT INTO company_resources(id,company_id,owner_id,request_key,input_hash,title,kind,domain,current_version,access)
          SELECT gen_random_uuid(),'one',CASE WHEN i<=1005 THEN 'bob' ELSE 'alice' END,'recall-bulk-'||i,repeat('a',64),'Unrelated newer record','document',CASE WHEN i<=1005 THEN 'reference' ELSE 'another-domain' END,1,'{"scope":"personal","readerIds":[]}'::jsonb FROM generate_series(1,2010) i RETURNING id,owner_id
        ) INSERT INTO resource_versions(resource_id,version,digest,body,source_refs,created_by) SELECT id,1,repeat('b',64),'necessary-evidence','[]'::jsonb,owner_id FROM inserted`);
        const response=await app.inject({url:'/v1/resources?query=necessary-evidence&domain=reference',headers:{authorization:'Bearer '+await host.issueAccessToken('alice')}});
        expect(response.statusCode).toBe(200);expect(response.json().items.map((r:any)=>r.id)).toEqual([own.id]);expect(response.json().limited).toBe(false);
        await host.db.pool.query(`WITH inserted AS (
          INSERT INTO company_resources(id,company_id,owner_id,request_key,input_hash,title,kind,domain,current_version,access)
          SELECT gen_random_uuid(),'one','alice','page-'||i,repeat('c',64),'Paged own record','document','pages',1,'{"scope":"personal","readerIds":[]}'::jsonb FROM generate_series(1,205) i RETURNING id
        ) INSERT INTO resource_versions(resource_id,version,digest,body,source_refs,created_by) SELECT id,1,repeat('d',64),'paged evidence','[]'::jsonb,'alice' FROM inserted`);
        const ids:string[]=[];let cursor:string|null=null;let firstCursor='';
        do{const page=await host.resources.index('alice','','pages',{limit:50,...(cursor?{cursor}:{})});ids.push(...page.items.map((i:any)=>i.id));cursor=page.nextCursor;if(!firstCursor&&cursor)firstCursor=cursor;}while(cursor);
        expect(ids).toHaveLength(205);expect(new Set(ids).size).toBe(205);
        await expect(host.resources.index('alice','different-query','pages',{cursor:firstCursor})).rejects.toMatchObject({code:'INVALID_INPUT'});
    }finally{await app.close();await host.close();}
});
