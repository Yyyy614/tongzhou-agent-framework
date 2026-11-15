import { createFramework } from '../dist/index.js';
import { createServer } from '../dist/server.js';
import { HarnessRuntime } from '../dist/runtime.js';
import { TaskQueue } from '../dist/tasks.js';
import { HostLease } from '../dist/host-lease.js';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const directory=resolve('.local/v04-isolated');await mkdir(directory,{recursive:true});
const host=await createFramework({root:resolve(directory,'host')});
const lease=await HostLease.acquire(host.db);
let app,runtime,queue,closing=false;
async function stop(){if(closing)return;closing=true;await host.assistant?.close();await runtime?.close();await queue?.close();await app?.close();await lease.close();await host.close();}
try{
    for(const path of ['examples/plugins/document-check','examples/plugins/inventory-check','packages/work-assistant','packages/connection-catalog','packages/private-memory'])await host.installPlugin(resolve(path));
    const actorId='v04-employee',companyId='v04-isolated-company';
    const tools=['@independent/document-check:document.check','@independent/inventory-check:inventory.compare','@company/work-assistant:work.list','@company/work-assistant:work.read','@company/work-assistant:reminder.schedule','@company/work-assistant:reminder.list','@company/work-assistant:inbox.list','@company/connection-catalog:connections.catalog','@company/connection-catalog:connections.describe'];
    const services=['memory.self.read','memory.self.propose_write','report.self.write','work.read','reminder.read','reminder.write','inbox.self.read','connection.catalog.read'];
    async function createActor(value){try{await host.db.get('actors',value.id);}catch(error){if(error.code!=='NOT_FOUND')throw error;await host.putActor(value);}}
    await createActor({id:'v04-admin',companyId,displayName:'隔离环境管理员',role:'admin',permissions:[]});
    await createActor({id:actorId,companyId,displayName:'公司发行版测试员工',role:'employee',permissions:[...tools.map(tool=>'tool.invoke:'+tool),...services]});
    for(const[id,name,pluginId,businessTool,index]of [['v04-documents','资料核对岗','@independent/document-check',tools[0],'DOCUMENTS_PRIVATE_INDEX'],['v04-inventory','库存核对岗','@independent/inventory-check',tools[1],'INVENTORY_PRIVATE_INDEX']]){
        try{await host.db.get('agents',id);}catch(error){if(error.code!=='NOT_FOUND')throw error;await host.putAgent({id,companyId,ownerId:actorId,displayName:name,preset:{id:'company-worker',version:'0.1.0'},pluginId,pluginVersion:'0.1.0',plugins:[{pluginId:'@company/work-assistant',pluginVersion:'0.1.0'},{pluginId:'@company/connection-catalog',pluginVersion:'0.1.0'},{pluginId:'@company/private-memory',pluginVersion:'0.1.0'}],allowedTools:[businessTool,...tools.slice(2)],servicePermissions:services,instructions:'这是隔离环境的岗位验证。只处理本人负责的工作，按需读取INDEX；优先调用此岗位挂载的业务工具，报告实际执行结果，不声称操作真实业务系统。'});}
        try{await host.readMemory({principalId:actorId,agentId:id,noteId:'INDEX'});}catch(error){if(error.code!=='NOT_FOUND')throw error;await host.writeMemory({principalId:actorId,agentId:id,noteId:'INDEX',expectedVersion:0,markdown:'# 独立岗位索引\n'+index+'\n此笔记只属于当前岗位。',sourceRefs:['acceptance:v04-isolated']});}
    }
    const accessFile=resolve(directory,'access.json');let access;
    try{access=JSON.parse(await readFile(accessFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(typeof access?.admin!=='string'){access={admin:await host.issueAccessToken('v04-admin')};await writeFile(accessFile,JSON.stringify(access),{mode:0o600});}
    app=await createServer(host);let upstream=(process.env.DEEPSEEK_BASE_URL??'https://api.deepseek.com').replace(/\/$/u,'');if(upstream==='https://api.deepseek.com')upstream+='/anthropic';
    runtime=new HarnessRuntime(app,host,{apiKey:process.env.DEEPSEEK_API_KEY??'',upstreamURL:upstream,model:process.env.DEEPSEEK_MODEL??'deepseek-flash',publicOrigin:'http://127.0.0.1:4417',maxConcurrentRuns:3});
    queue=new TaskQueue(host,runtime,3);runtime.enableDelegation(queue);await queue.open();queue.registerRoutes(app);await runtime.recoverInterrupted();await queue.recoverInterrupted();
    const employeeFile=resolve(directory,'employee.json');
    try{await readFile(employeeFile);}catch(error){
        if(error.code!=='ENOENT')throw error;
        const invite=await app.inject({method:'POST',url:'/v1/admin/employees/'+actorId+'/invitations',headers:{authorization:'Bearer '+access.admin},payload:{}});
        if(invite.statusCode!==201)throw Error('Isolated invitation failed: '+invite.statusCode);
        const password=randomBytes(24).toString('base64url');
        const registered=await app.inject({method:'POST',url:'/v1/employee/register',payload:{code:invite.json().code,password,deviceName:'isolated-bootstrap'}});
        if(registered.statusCode!==201)throw Error('Isolated account registration failed: '+registered.statusCode);
        const registeredDevice=registered.json();
        await writeFile(employeeFile,JSON.stringify({username:actorId,password,serverURL:'http://127.0.0.1:4417'}),{mode:0o600});
        const loggedOut=await app.inject({method:'POST',url:'/v1/employee/logout',headers:{authorization:'Bearer '+registeredDevice.accessToken},payload:{}});
        if(loggedOut.statusCode!==200)throw Error('Isolated bootstrap device logout failed');
    }
    await app.listen({host:'127.0.0.1',port:4417});await queue.startWorker();host.assistant?.start();
    await writeFile(resolve(directory,'runtime.json'),JSON.stringify({pid:process.pid,url:app.listeningOrigin,schema:host.db.schema,root:host.options.root,startedAt:new Date().toISOString()}));
    console.log(JSON.stringify({status:'ready',url:app.listeningOrigin,isolated:true,existingDataChanged:false}));
    process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
}catch(error){await stop();console.error('Isolated service failed: '+(error.code??error.message));process.exitCode=1;}
