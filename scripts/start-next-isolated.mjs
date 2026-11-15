import {createFramework} from '../dist/index.js';
import {createServer} from '../dist/server.js';
import {HarnessRuntime} from '../dist/runtime.js';
import {TaskQueue} from '../dist/tasks.js';
import {HostLease} from '../dist/host-lease.js';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';

// A fresh namespace, database schema, credentials and fixed loopback port. Never migrates a deployed host.
const directory=resolve('.local/v06'),companyId='v06-isolated-company';await mkdir(directory,{recursive:true});
if(!process.env.DATABASE_URL)throw Error('Set DATABASE_URL to an isolated PostgreSQL database before starting this test host');
const host=await createFramework({root:resolve(directory,'host'),entries:true});const lease=await HostLease.acquire(host.db);let app,runtime,queue,closing=false;
async function stop(){if(closing)return;closing=true;await host.assistant?.close();await runtime?.close();await queue?.close();await app?.close();await lease.close();await host.close();}
try{
    for(const path of ['examples/plugins/document-check','examples/plugins/inventory-check','packages/private-memory','packages/work-assistant'])await host.installPlugin(resolve(path));
    const services=['memory.self.read','memory.self.propose_write','report.self.write'];
    for(const actor of [{id:'v06-admin',displayName:'隔离测试管理员',role:'admin',permissions:[]},{id:'v06-employee',displayName:'林悦',role:'employee',permissions:[...services,'inbox.self.read','tool.invoke:@independent/document-check:document.check']},{id:'v06-peer',displayName:'陈安',role:'employee',permissions:[...services,'inbox.self.read']}]){
        try{const prior=await host.db.get('actors',actor.id);if(prior.companyId!==companyId)throw Error('Unexpected isolated identity');if(actor.permissions.some(p=>!prior.permissions.includes(p)))await host.putActor({...prior,permissions:[...new Set([...prior.permissions,...actor.permissions])]});}catch(e){if(e.code!=='NOT_FOUND')throw e;await host.putActor({...actor,companyId});}
    }
    for(const [id,ownerId,displayName,pluginId,tool]of [['v06-documents','v06-employee','资料核对岗','@independent/document-check','@independent/document-check:document.check'],['v06-inventory','v06-peer','另一独立岗位','@independent/inventory-check',null]]){
        try{await host.db.get('agents',id);}catch(e){if(e.code!=='NOT_FOUND')throw e;await host.putAgent({id,ownerId,companyId,displayName,pluginId,pluginVersion:'0.1.0',plugins:[{pluginId:'@company/private-memory',pluginVersion:'0.1.0'}],allowedTools:tool?[tool]:[],servicePermissions:services,preset:{id:'company-worker',version:'0.1.0'},instructions:'这是通用框架隔离验收，不操作真实业务系统。按需读取已安装 Skill；仅使用实际授权工具。需要返回成果时保存资源并记录 work_report；没有来源的结论需说明。'});}
        try{await host.readMemory({principalId:ownerId,agentId:id,noteId:'INDEX'});}catch(e){if(e.code!=='NOT_FOUND')throw e;await host.writeMemory({principalId:ownerId,agentId:id,noteId:'INDEX',expectedVersion:0,markdown:'# 岗位独立索引\n此处仅存当前岗位负责工作的索引。需要公司资料时查询授权资源目录。',sourceRefs:['acceptance:v06']});}
    }
    const accessPath=resolve(directory,'access.json');let access;try{access=JSON.parse(await readFile(accessPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;access={admin:await host.issueAccessToken('v06-admin')};await writeFile(accessPath,JSON.stringify(access),{mode:0o600});}
    app=await createServer(host,{webProfile:'studio'});let upstream=(process.env.DEEPSEEK_BASE_URL??'https://api.deepseek.com').replace(/\/$/u,'');if(upstream==='https://api.deepseek.com')upstream+='/anthropic';
    runtime=new HarnessRuntime(app,host,{apiKey:process.env.DEEPSEEK_API_KEY??'',upstreamURL:upstream,model:process.env.DEEPSEEK_MODEL??'deepseek-flash',publicOrigin:'http://127.0.0.1:55061'});
    queue=new TaskQueue(host,runtime,3);runtime.enableDelegation(queue);await queue.open();queue.registerRoutes(app);await runtime.recoverInterrupted();await queue.recoverInterrupted();
    for(const id of ['v06-employee','v06-peer']){const path=resolve(directory,id+'.json');try{await readFile(path);}catch(e){if(e.code!=='ENOENT')throw e;const invitation=await app.inject({method:'POST',url:'/v1/admin/employees/'+id+'/invitations',headers:{authorization:'Bearer '+access.admin},payload:{}});if(invitation.statusCode!==201)throw Error('Isolated account invitation failed');const password=randomBytes(24).toString('base64url'),registered=await app.inject({method:'POST',url:'/v1/employee/register',payload:{code:invitation.json().code,password,deviceName:'v06-bootstrap'}});if(registered.statusCode!==201)throw Error('Isolated account registration failed');await writeFile(path,JSON.stringify({username:id,password,serverURL:'http://127.0.0.1:55061'}),{mode:0o600});await app.inject({method:'POST',url:'/v1/employee/logout',headers:{authorization:'Bearer '+registered.json().accessToken},payload:{}});}}
    await app.listen({host:'127.0.0.1',port:55061});await queue.startWorker();host.assistant?.start();
    await writeFile(resolve(directory,'runtime.json'),JSON.stringify({pid:process.pid,url:app.listeningOrigin,schema:host.db.schema,root:host.options.root,isolated:true}));
    console.log(JSON.stringify({ready:true,url:app.listeningOrigin,isolated:true}));process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
}catch(e){await stop();console.error('Isolated host failed: '+(e.code??e.message));process.exitCode=1;}
