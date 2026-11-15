import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { createCompanySession } from '../../client/company-session.mjs';
import { windowsProtection } from '../../client/credential-store.mjs';
import { companyFetch } from '../../client/company-fetch.mjs';
const directory=resolve('.local/company-cloud-041'),account=JSON.parse(await readFile(join(directory,'private-account.json'),'utf8'));
const admin=JSON.parse(await readFile('.local/staging/private/access.json','utf8')).admin;
const scope=createHash('sha256').update(account.serverURL).digest('hex').slice(0,20);
const first=JSON.parse(await readFile(resolve(process.env.APPDATA,'CompanyHarness/cloud-v04-test',scope,'identity.json'),'utf8'));
const secondDirectory=join(directory,'second-device');
const session=await createCompanySession({serverURL:account.serverURL,dataDir:secondDirectory,protection:windowsProtection,runtime:{start:async()=>{},stop:async()=>{}}});
async function request(path,{method='GET',body,token,expected=200}={}){const response=await companyFetch(account.serverURL,path,{method,body,token});assert.equal(response.status,expected,path);return response.json();}
const mode=process.argv[2];
try{
    if(mode==='--devices'){
        const state=await session.login({username:account.username,password:account.password,deviceName:'公司Harness换机验收B'});
        assert.deepEqual(state.agents.map(agent=>agent.id).sort(),[...account.agentIds].sort());
        const second=JSON.parse(await readFile(join(secondDirectory,'identity.json'),'utf8'));
        assert.notEqual(first.deviceId,second.deviceId);assert.notEqual(first.encryptedToken,second.encryptedToken);
        const token=await windowsProtection.decrypt(second.encryptedToken);
        for(const [id,marker] of [['harness-cloud-documents','CLOUD_DOCUMENTS_PRIVATE_INDEX'],['harness-cloud-inventory','CLOUD_INVENTORY_PRIVATE_INDEX']])assert((await request('/v1/agents/'+id+'/memory/INDEX',{token})).markdown.includes(marker));
        const plugins=await request('/v1/plugins',{token});for(const id of ['@independent/document-check','@independent/inventory-check','@company/private-memory'])assert(plugins.some(plugin=>plugin.id===id&&plugin.version==='0.1.0'));
        await request('/v1/agents/harness-cloud-peer-agent/memory/INDEX',{token,expected:403});
        await request('/v1/admin/employees',{token,expected:403});
        const result={testedAt:new Date().toISOString(),serverURL:account.serverURL,username:account.username,twoFreshDeviceProfiles:true,distinctDeviceIds:true,distinctProtectedTokens:true,assignedJobsAndPlugins:true,samePrivateIndexes:true,otherEmployeeMemoryDenied:true,employeeAdminDenied:true,physicalSecondComputerVerified:false};
        await writeFile(join(directory,'two-devices.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
    }else if(mode==='--run'){
        const id=process.argv[3];assert.match(id??'',/^[a-f0-9-]{36}$/u);
        const identity=JSON.parse(await readFile(join(secondDirectory,'identity.json'),'utf8')),token=await windowsProtection.decrypt(identity.encryptedToken);
        const run=await request('/v1/runs/'+id,{token});assert.equal(run.state,'succeeded');assert.equal(run.source,'harness-client');assert.equal(run.principalId,account.username);assert.equal(run.agentId,'harness-cloud-documents');
        const events=(await request('/v1/agents/'+run.agentId+'/logs',{token})).filter(log=>log.data.runId===id);
        assert(events.some(log=>log.type==='tool.succeeded'));assert(events.some(log=>log.type==='report.recorded'));assert(events.some(log=>log.type==='runtime.tool_succeeded'&&log.data.toolName==='memory_read'));assert(events.some(log=>log.type==='runtime.tool_succeeded'&&log.data.toolName==='memory_write'));
        const note=await request('/v1/agents/'+run.agentId+'/memory/CROSS_DEVICE_CHECK',{token});assert(note.markdown.includes('CLOUD_041_SECOND_DEVICE_READY'));
        const records=(await request('/v1/agents/'+run.agentId+'/usage',{token})).records.filter(item=>item.runId===id);assert(records.length>0&&records.every(item=>item.measurement==='provider'&&item.principalId===account.username&&item.agentId===run.agentId));
        const adminLogs=await request('/v1/agents/'+run.agentId+'/logs',{token:admin});assert(adminLogs.some(log=>log.type==='report.recorded'&&log.data.runId===id));
        const result={testedAt:new Date().toISOString(),serverURL:account.serverURL,runId:id,employee:account.username,agentId:run.agentId,state:run.state,source:run.source,pluginReceipt:true,privateMemoryReadAndWrite:true,secondDeviceReadsNewMemory:true,reportReceipt:true,providerRequests:records.length,adminCanSeeLogs:true,physicalSecondComputerVerified:false};
        await writeFile(join(directory,'native-cloud-run.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
    }else if(mode==='--revoke-second'){
        const identity=JSON.parse(await readFile(join(secondDirectory,'identity.json'),'utf8'));assert.notEqual(identity.deviceId,first.deviceId);
        const token=await windowsProtection.decrypt(identity.encryptedToken);
        await request('/v1/admin/employees/'+account.username+'/devices/'+identity.deviceId,{method:'DELETE',token:admin});
        await request('/v1/employee/bootstrap',{token,expected:401});
        const devices=await request('/v1/admin/employees/'+account.username+'/devices',{token:admin});
        const firstDevice=devices.find(device=>device.id===first.deviceId);assert(firstDevice,'First device must still exist');assert(!firstDevice.revokedAt);assert(Date.parse(firstDevice.expiresAt)>Date.now(),'First device must still be unexpired');
        await writeFile(join(directory,'revocation.json'),JSON.stringify({testedAt:new Date().toISOString(),secondDeviceRevoked:true,revokedDeviceDenied:true,firstDeviceStillEnabled:true},null,2));console.log('Second device revoked; first device remains enabled.');
    }else throw Error('Use --devices, --run <exact-run-id> or --revoke-second');
}finally{await session.close();}
