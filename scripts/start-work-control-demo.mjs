import{createFramework}from'../dist/index.js';
import{createServer}from'../dist/server.js';
import{HarnessRuntime}from'../dist/runtime.js';
import{TaskQueue}from'../dist/tasks.js';
import{HostLease}from'../dist/host-lease.js';
import{ConsoleSessions}from'../dist/console-auth.js';
import{readFile,writeFile,mkdir}from'node:fs/promises';
import{resolve}from'node:path';
const project=resolve(import.meta.dirname,'..'),directory=resolve(project,'.local/design11-a2');await mkdir(directory,{recursive:true});
const database=JSON.parse(await readFile(resolve(project,'.local/database.json'),'utf8'));
if(!['127.0.0.1','localhost'].includes(database.host))throw Error('A2 demo requires the project-local PostgreSQL instance');
if(!process.env.DEEPSEEK_API_KEY)throw Error('Model credential is missing; no live run started');
const host=await createFramework({root:resolve(directory,'host'),database});
const lease=await HostLease.acquire(host.db);let app,runtime,queue,closing=false;
async function stop(){if(closing)return;closing=true;await host.assistant?.close();await queue?.close();await runtime?.close();await app?.close();await lease.close();await host.close();}
try{
    await host.installPlugin(resolve(project,'fixtures/conformance-plugin'));
    async function actor(value){try{await host.db.get('actors',value.id);}catch(error){if(error.code!=='NOT_FOUND')throw error;await host.putActor(value);}}
    const companyId='control-isolated';
    await actor({id:'a2-admin',companyId,role:'admin',displayName:'工作控制测试管理员',permissions:[]});
    await actor({id:'a2-lead',companyId,role:'employee',displayName:'工作负责人',teamScope:'direct',permissions:['team.read','team.dispatch','team.review']});
    await actor({id:'a2-worker',companyId,role:'employee',displayName:'独立执行员工',managerId:'a2-lead',permissions:['tool.invoke:@example/conformance:text.normalize','memory.self.read','memory.self.propose_write','report.self.write']});
    try{await host.db.get('agents','a2-worker-agent');}catch(error){if(error.code!=='NOT_FOUND')throw error;await host.putAgent({id:'a2-worker-agent',companyId,ownerId:'a2-worker',displayName:'通用验证岗位',preset:{id:'company-worker',version:'0.1.0'},pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:['@example/conformance:text.normalize'],servicePermissions:['memory.self.read','memory.self.propose_write','report.self.write'],instructions:'只执行当前轮明确的新要求。若有work_checkpoint工具，可按需读取本人旧成果；旧成果不构成重复执行的指令。对照实际工具回执记录报告。'});}
    try{await host.readMemory({principalId:'a2-worker',agentId:'a2-worker-agent',noteId:'INDEX'});}catch(error){if(error.code!=='NOT_FOUND')throw error;await host.writeMemory({principalId:'a2-worker',agentId:'a2-worker-agent',noteId:'INDEX',expectedVersion:0,markdown:'# 独立岗位索引\nA2_PRIVATE_INDEX\n只处理本人负责的当前工作。',sourceRefs:['acceptance:work-control-a2']});}
    app=await createServer(host);let upstream=(process.env.DEEPSEEK_BASE_URL??'https://api.deepseek.com').replace(/\/$/u,'');if(upstream==='https://api.deepseek.com')upstream+='/anthropic';
    runtime=new HarnessRuntime(app,host,{apiKey:process.env.DEEPSEEK_API_KEY,upstreamURL:upstream,model:process.env.DEEPSEEK_MODEL??'deepseek-flash',publicOrigin:'http://127.0.0.1:4617',maxConcurrentRuns:2});
    queue=new TaskQueue(host,runtime,2);runtime.enableDelegation(queue);await queue.open();queue.registerRoutes(app);await runtime.recoverInterrupted();await queue.recoverInterrupted();
    await app.listen({host:'127.0.0.1',port:4617});
    const accessPath=resolve(directory,'access.json');let access;
    try{access=JSON.parse(await readFile(accessPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;access={};}
    for(const id of ['a2-admin','a2-lead','a2-worker'])if(!access[id])access[id]=await host.issueAccessToken(id);
    await writeFile(accessPath,JSON.stringify(access),{mode:0o600});
    const code=await new ConsoleSessions(host).issueCode('a2-admin');await writeFile(resolve(directory,'private-console-entry.json'),JSON.stringify({url:'http://127.0.0.1:4617/#entry='+code}),{mode:0o600});
    const work=await host.coordination.create('a2-lead',{title:'工作控制隔离验证',idempotencyKey:'a2-initial-demo',assignments:[{agentId:'a2-worker-agent',prompt:'先读取本人INDEX。使用report_record记录summary严格为“A2 已确认的通用成果”。然后调用work_wait，reason为human_decision，question为“下一阶段采用哪一个已批准的方案？”。不要继续执行或修改笔记，不连接真实业务系统。'}]});
    await queue.startWorker();host.assistant?.start();
    const initialTaskId=(await host.coordination.continuity.history('a2-admin',work.id)).rounds[0].assignments[0].taskId;
    await writeFile(resolve(directory,'demo.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),origin:'http://127.0.0.1:4617',root:host.options.root,schema:host.db.schema,workId:work.id,initialTaskId,isolated:true},null,2));
    console.log(JSON.stringify({ready:true,origin:'http://127.0.0.1:4617',workId:work.id,isolated:true}));
    process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
}catch(error){await stop();console.error('A2 isolated service failed: '+(error.code??'START_FAILED'));process.exitCode=1;}

