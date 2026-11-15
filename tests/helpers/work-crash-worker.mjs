import{createFramework}from'../../src/index.ts';
import{TaskQueue}from'../../src/tasks.ts';
import{HostLease}from'../../src/host-lease.ts';
import{readFile,writeFile,appendFile}from'node:fs/promises';
import{resolve}from'node:path';
const root=resolve(process.argv[2]);if(!root.startsWith(resolve('.test-data')+ '/'.replace('/',process.platform==='win32'?'\\':'/')))throw Error('Test root is not isolated');
const database=JSON.parse(await readFile('.local/database.json','utf8'));if(!['127.0.0.1','localhost'].includes(database.host))throw Error('Local database required');
const host=await createFramework({root,database});await HostLease.acquire(host.db);
await host.installPlugin(resolve('fixtures/conformance-plugin'));await host.putActor({id:'lead',companyId:'one',role:'admin',permissions:[]});await host.putActor({id:'alice',companyId:'one',role:'employee',permissions:[]});
await host.putAgent({id:'alice-agent',companyId:'one',ownerId:'alice',pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:[]});
const queue=new TaskQueue(host,{async run(request){
    await host.coordination.control.actions.execute(request,'external-effect',{operation:'one'},async()=>{
        await appendFile(resolve(root,'external-effect.txt'),'effect happened\n');await writeFile(resolve(root,'crash-ready.json'),JSON.stringify({workId:request.workId,taskId:request.taskId}));
        await new Promise(()=>{});
    });return{id:'unreachable',state:'succeeded'};
}});await queue.open();
const{WorkCoordinator}=await import('../../src/work.ts');new WorkCoordinator(host,queue);
await host.coordination.create('lead',{title:'Crash isolation',idempotencyKey:'crash',assignments:[{agentId:'alice-agent',prompt:'one effect'}]});await queue.startWorker();
