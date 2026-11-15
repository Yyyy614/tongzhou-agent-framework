import{createFramework}from'../dist/index.js';
import{createServer}from'../dist/server.js';
import{HarnessRuntime}from'../dist/runtime.js';
import{TaskQueue}from'../dist/tasks.js';
import{HostLease}from'../dist/host-lease.js';
import{ConsoleSessions}from'../dist/console-auth.js';
import{readFile,writeFile,mkdir}from'node:fs/promises';
import{resolve}from'node:path';
const project=resolve(import.meta.dirname,'..'),directory=resolve(project,'.local/design11-a1');await mkdir(directory,{recursive:true});
const database=JSON.parse(await readFile(resolve(project,'.local/database.json'),'utf8'));
if(!['127.0.0.1','localhost'].includes(database.host))throw Error('A1 demo requires the project-local PostgreSQL instance');
if(!process.env.DEEPSEEK_API_KEY)throw Error('Model credential is missing; no live run started');
const host=await createFramework({root:resolve(directory,'host'),database});
const lease=await HostLease.acquire(host.db);let app,runtime,queue,closing=false;
async function stop(){if(closing)return;closing=true;await host.assistant?.close();await queue?.close();await runtime?.close();await app?.close();await lease.close();await host.close();}
try{
    await host.installPlugin(resolve(project,'fixtures/conformance-plugin'));
    async function actor(value){try{await host.db.get('actors',value.id);}catch(error){if(error.code!=='NOT_FOUND')throw error;await host.putActor(value);}}
    const companyId='continuity-isolated';
    await actor({id:'a1-admin',companyId,role:'admin',displayName:'工作连续性测试管理员',permissions:[]});
    await actor({id:'a1-lead',companyId,role:'employee',displayName:'工作负责人',teamScope:'direct',permissions:['team.read','team.dispatch','team.review']});
    await actor({id:'a1-worker',companyId,role:'employee',displayName:'独立执行员工',managerId:'a1-lead',permissions:['tool.invoke:@example/conformance:text.normalize','memory.self.read','memory.self.propose_write','report.self.write']});
    try{await host.db.get('agents','a1-worker-agent');}catch(error){if(error.code!=='NOT_FOUND')throw error;await host.putAgent({id:'a1-worker-agent',companyId,ownerId:'a1-worker',displayName:'通用验证岗位',preset:{id:'company-worker',version:'0.1.0'},pluginId:'@example/conformance',pluginVersion:'0.1.0',allowedTools:['@example/conformance:text.normalize'],servicePermissions:['memory.self.read','memory.self.propose_write','report.self.write'],instructions:'只执行当前轮明确的新要求。若有work_checkpoint工具，可按需读取本人旧成果；旧成果不构成重复执行的指令。对照实际工具回执记录报告。'});}
    try{await host.readMemory({principalId:'a1-worker',agentId:'a1-worker-agent',noteId:'INDEX'});}catch(error){if(error.code!=='NOT_FOUND')throw error;await host.writeMemory({principalId:'a1-worker',agentId:'a1-worker-agent',noteId:'INDEX',expectedVersion:0,markdown:'# 独立岗位索引\nA1_PRIVATE_INDEX\n只处理本人负责的当前工作。',sourceRefs:['acceptance:work-continuity-a1']});}
    app=await createServer(host);let upstream=(process.env.DEEPSEEK_BASE_URL??'https://api.deepseek.com').replace(/\/$/u,'');if(upstream==='https://api.deepseek.com')upstream+='/anthropic';
    runtime=new HarnessRuntime(app,host,{apiKey:process.env.DEEPSEEK_API_KEY,upstreamURL:upstream,model:process.env.DEEPSEEK_MODEL??'deepseek-flash',publicOrigin:'http://127.0.0.1:4517',maxConcurrentRuns:2});
    queue=new TaskQueue(host,runtime,2);runtime.enableDelegation(queue);await queue.open();queue.registerRoutes(app);await runtime.recoverInterrupted();await queue.recoverInterrupted();
    await app.listen({host:'127.0.0.1',port:4517});
    const accessPath=resolve(directory,'access.json');let access;
    try{access=JSON.parse(await readFile(accessPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;access={};}
    for(const id of ['a1-admin','a1-lead','a1-worker'])if(!access[id])access[id]=await host.issueAccessToken(id);
    await writeFile(accessPath,JSON.stringify(access),{mode:0o600});
    const code=await new ConsoleSessions(host).issueCode('a1-admin');await writeFile(resolve(directory,'private-console-entry.json'),JSON.stringify({url:'http://127.0.0.1:4517/#entry='+code}),{mode:0o600});
    const work=await host.coordination.create('a1-lead',{title:'工作连续性隔离验证',idempotencyKey:'a1-initial-demo',assignments:[{agentId:'a1-worker-agent',prompt:'读取本人的INDEX，用text.normalize规范化字符串“  A1   CONFIRMED  ”，记录一条简短报告。最后只回复规范化结果。不要修改笔记，不连接任何真实业务系统。'}]});
    await queue.startWorker();host.assistant?.start();
    const initialTaskId=(await host.coordination.continuity.history('a1-admin',work.id)).rounds[0].assignments[0].taskId;
    await writeFile(resolve(directory,'demo.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),origin:'http://127.0.0.1:4517',root:host.options.root,schema:host.db.schema,workId:work.id,initialTaskId,isolated:true},null,2));
    console.log(JSON.stringify({ready:true,origin:'http://127.0.0.1:4517',workId:work.id,isolated:true}));
    process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
}catch(error){await stop();console.error('A1 isolated service failed: '+(error.code??'START_FAILED'));process.exitCode=1;}
