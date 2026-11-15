// Additive acceptance data in the existing isolated test environment only.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { companyFetch } from '../../client/company-fetch.mjs';
import { guardCloudFixture } from './cloud-fixture-guard.mjs';
const origin='https://sales.hongkeweilai.com:8443',directory='.local/company-cloud-041';
await mkdir(directory,{recursive:true});
const admin=JSON.parse(await readFile('.local/staging/private/access.json','utf8')).admin;
async function request(path,method='GET',body,token=admin,expected=200){const response=await companyFetch(origin,path,{method,body,token});const result=await response.json();if(response.status!==expected)throw Error(path+': '+response.status+' '+(result.error?.code??''));return result;}
const initialEmployees=await request('/v1/admin/employees'),initialAgents=await request('/v1/admin/agents');
const username='harness-cloud-test',peer='harness-cloud-peer';
const actorIds=[username,peer],agentIds=['harness-cloud-documents','harness-cloud-inventory'],allAgentIds=[...agentIds,'harness-cloud-peer-agent'];
const accountPath=directory+'/private-account.json';let account;
try{account=JSON.parse(await readFile(accountPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const ownership=guardCloudFixture({serverURL:origin,username,agentIds,actorIds,allAgentIds,employees:initialEmployees,agents:initialAgents,account});
const existing=[...initialEmployees.filter(record=>!actorIds.includes(record.id)),...initialAgents.filter(record=>!allAgentIds.includes(record.id))];
if(!account){account={serverURL:origin,username,password:randomBytes(20).toString('base64url'),agentIds,registered:false};await writeFile(accountPath,JSON.stringify(account,null,2),{flag:'wx',mode:0o600});}
try{await writeFile(directory+'/existing-records-before.json',JSON.stringify(existing,null,2),{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
let registry=await request('/v1/plugins');
for(const [id,path] of [['@independent/document-check','examples/plugins/document-check'],['@independent/inventory-check','examples/plugins/inventory-check'],['@company/private-memory','packages/private-memory']]){
    if(!registry.some(plugin=>plugin.id===id&&plugin.version==='0.1.0'))await request('/v1/plugins/install','POST',{path:'/app/.local/imports/harness-cloud-041/'+path});
}
const tools=['@independent/document-check:document.check','@independent/inventory-check:inventory.compare','@company/work-assistant:work.list','@company/work-assistant:work.read','@company/work-assistant:reminder.schedule','@company/work-assistant:reminder.list','@company/work-assistant:inbox.list','@company/connection-catalog:connections.catalog','@company/connection-catalog:connections.describe'];
const services=['memory.self.read','memory.self.propose_write','report.self.write','work.read','reminder.read','reminder.write','inbox.self.read','connection.catalog.read'];
for(const [id,name]of [[username,'公司Harness云端测试员工'],[peer,'独立权限验证员工']])if(!initialEmployees.some(actor=>actor.id===id))await request('/v1/admin/employees','POST',{id,displayName:name,department:'公司Harness隔离验收',role:'employee',permissions:[...tools.map(tool=>'tool.invoke:'+tool),...services]},admin,201);
const roles=[['harness-cloud-documents','资料核对岗',username,'@independent/document-check',tools[0],'CLOUD_DOCUMENTS_PRIVATE_INDEX'],['harness-cloud-inventory','库存核对岗',username,'@independent/inventory-check',tools[1],'CLOUD_INVENTORY_PRIVATE_INDEX'],['harness-cloud-peer-agent','独立权限验证岗',peer,'@independent/document-check',tools[0],'PEER_PRIVATE_INDEX']];
for(const [id,displayName,ownerId,pluginId,businessTool,marker]of roles){
    if(!initialAgents.some(agent=>agent.id===id))await request('/v1/admin/agents','POST',{id,displayName,ownerId,preset:{id:'company-worker',version:'0.1.0'},pluginId,pluginVersion:'0.1.0',plugins:[{pluginId:'@company/work-assistant',pluginVersion:'0.1.0'},{pluginId:'@company/connection-catalog',pluginVersion:'0.1.0'},{pluginId:'@company/private-memory',pluginVersion:'0.1.0'}],allowedTools:[businessTool,...tools.slice(2)],servicePermissions:services,instructions:'本岗位用于公司Harness隔离验收。只按需读取自己的INDEX，使用已挂载插件，汇报事实。没有接入真实业务系统。'},admin,201);
    const notes=await request('/v1/agents/'+id+'/memory');
    if(!notes.some(note=>note.noteId==='INDEX'))await request('/v1/agents/'+id+'/memory/INDEX','PUT',{markdown:'# 云端岗位独立索引\n'+marker+'\n此索引属于该岗位；业务通过插件提供。',expectedVersion:0,sourceRefs:['acceptance:cloud-harness-041']});
}
const login=await companyFetch(origin,'/v1/employee/login',{method:'POST',body:{username,password:account.password,deviceName:'云端验收准备'}});
let device;
if(login.status===201)device=await login.json();else if(login.status===401&&ownership.mayCreateEmployee&&!account.registered){const invite=await request('/v1/admin/employees/'+username+'/invitations','POST',{},admin,201);device=await request('/v1/employee/register','POST',{code:invite.code,password:account.password,deviceName:'云端验收准备'},undefined,201);}else throw Error('Cloud test account preflight failed; an established password will not be reset: '+login.status);
await request('/v1/employee/logout','POST',{},device.accessToken);
account.registered=true;await writeFile(accountPath,JSON.stringify(account,null,2),{mode:0o600});
const current=[...await request('/v1/admin/employees'),...await request('/v1/admin/agents')];
const before=JSON.parse(await readFile(directory+'/existing-records-before.json','utf8'));
for(const old of before)if(JSON.stringify(old)!==JSON.stringify(current.find(item=>item.id===old.id&&Object.hasOwn(item,'role')===Object.hasOwn(old,'role'))))throw Error('A pre-existing employee or role changed: '+old.id);
await writeFile(directory+'/provisioning.json',JSON.stringify({preparedAt:new Date().toISOString(),serverURL:origin,username,agents:account.agentIds,plugins:['@independent/document-check','@independent/inventory-check','@company/private-memory'],previousEmployeeAndAgentRecordsUnchanged:true,serverRestarted:false,existingDownloadManifestReplaced:false},null,2));
console.log(JSON.stringify({prepared:true,username,agents:account.agentIds,previousRecordsUnchanged:true,passwordPrinted:false}));
