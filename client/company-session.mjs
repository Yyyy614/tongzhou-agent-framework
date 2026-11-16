import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { companyFetch } from './company-fetch.mjs';
import { companyOrigin } from './employee-app.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code });
const keyFor = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24);

/** Owns one company device and its in-application Harness host. runtime.isReady, when supplied, confirms current Host health before reuse. */
export async function createCompanySession({ serverURL, dataDir, protection, runtime }) {
    serverURL = companyOrigin(serverURL);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    dataDir = await realpath(dataDir);
    const identityPath = resolve(dataDir, 'identity.json');
    const pendingPath = resolve(dataDir, 'pending-releases.json');
    let identity, token, active, busy = false, closed = false, closing, transition = Promise.resolve();
    let pendingReleases = [];
    try {
        identity = JSON.parse(await readFile(identityPath, 'utf8'));
        if (identity.serverURL !== serverURL) throw failure('DEVICE_SCOPE_MISMATCH', '设备目录属于另一个公司服务');
        token = await protection.decrypt(identity.encryptedToken);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
        const pending = JSON.parse(await readFile(pendingPath,'utf8'));
        if(pending.serverURL!==serverURL)throw failure('INVALID_DEVICE_STATE','待清理连接记录属于另一个公司服务');
        // Preserve pre-release records without guessing which employee owns them.
        const records=pending.releases??pending.leaseIds?.map(id=>({id,ownerId:null,companyId:null}));
        if(!Array.isArray(records)||records.some(item=>typeof item.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/u.test(item.id)||(item.ownerId!==null&&typeof item.ownerId!=='string')||(item.companyId!==null&&typeof item.companyId!=='string')))throw failure('INVALID_DEVICE_STATE','待清理连接记录无效');
        pendingReleases=records;
    }catch(error){if(error.code!=='ENOENT')throw error;}

    async function request(path, method = 'GET', body, credential = token, timeoutMs) {
        const response = await companyFetch(serverURL, path, { method, body, token: credential, timeoutMs });
        let result;
        try { result = await response.json(); }
        catch { throw failure('INVALID_RESPONSE', '公司服务返回了无法识别的结果，请稍后重试'); }
        if (!response.ok) throw Object.assign(failure(result.error?.code ?? 'UNAVAILABLE', ({ UNAUTHENTICATED: '账号或密码不正确，或登录已失效', PERMISSION_DENIED: '没有这项操作权限', CONFLICT: '岗位状态已变化，请刷新后重试', BUDGET_EXCEEDED: '设备或任务额度已满，请稍后重试' })[result.error?.code] ?? '公司服务未确认操作，请刷新后核对'), { status: response.status });
        return result;
    }
    async function exclusive(action) {
        if (closed) throw failure('CLIENT_CLOSED', '公司客户端已经关闭');
        if (closing) throw failure('CLIENT_CLOSING', '公司客户端正在退出');
        if (busy) throw failure('TRANSITION_BUSY', '正在切换岗位或登录，请稍候');
        busy = true;
        let settled;
        transition = new Promise(resolve => { settled = resolve; });
        try { return await action(); } finally { busy = false; settled(); }
    }
    async function removeIdentity() {
        await unlink(identityPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
        identity = undefined; token = undefined;
    }
    async function savePending() {
        if(!pendingReleases.length){await unlink(pendingPath).catch(error=>{if(error.code!=='ENOENT')throw error;});return;}
        await writeFile(pendingPath+'.tmp',JSON.stringify({serverURL,releases:pendingReleases}),{mode:0o600});await rename(pendingPath+'.tmp',pendingPath);
    }
    async function flushPending() {
        if(!token)return;
        for(const item of [...pendingReleases]){
            if(item.ownerId!==identity?.employee?.id||item.companyId!==identity?.employee?.companyId)continue;
            try{await request('/v1/harness/clients/'+item.id,'DELETE');}
            catch(error){if(error.status===401)return;if(error.status!==404)throw error;}
            pendingReleases=pendingReleases.filter(value=>value!==item);await savePending();
        }
    }
    async function retire({ exitOnly = false } = {}) {
        if (!active) return;
        let remoteError;
        if (!active.released) {
            try { await request('/v1/harness/clients/' + active.lease.id, 'DELETE',undefined,token,exitOnly?5000:20000);active.released=true; }
            catch (error) { if(error.status===404)active.released=true;else remoteError=error; }
        }
        // The runtime must await actual Host exit. A failed stop keeps ownership here.
        if(!active.stopped){await runtime.stop();active.stopped=true;active.started=false;}
        if(remoteError){
            if(!exitOnly)throw remoteError;
            if(!pendingReleases.some(item=>item.id===active.lease.id&&item.ownerId===active.ownerId&&item.companyId===active.companyId))pendingReleases.push({id:active.lease.id,ownerId:active.ownerId,companyId:active.companyId});
            await savePending();
        }
        active = undefined;
    }
    async function bootstrap() {
        if (!token) return undefined;
        await flushPending();
        try { return await request('/v1/employee/bootstrap'); }
        catch (error) {
            if (error.status !== 401) throw error;
            await retire({exitOnly:true}); await removeIdentity(); return undefined;
        }
    }
    async function publicState() {
        const boot = await bootstrap();
        if (!boot) return { authenticated: false, serverURL };
        const employee = { id: boot.employee.id, displayName: boot.employee.displayName, companyId: boot.employee.companyId };
        const agents = boot.agents.map(agent => ({ id: agent.id, displayName: agent.displayName ?? agent.id, preset: agent.preset, presetName: agent.presetName }));
        return { authenticated: true, serverURL, employee, agents, activeAgentId: active?.lease.agentId ?? null,workContext:active?.context??{resources:[]}, runtimeReady: !!active?.started && runtime.isReady?.() !== false };
    }
    async function login(input, register = false) {
        return exclusive(async () => {
            if (token || active) throw failure('ALREADY_SIGNED_IN', '请先退出当前公司账号');
            if (typeof input.deviceName !== 'string' || !input.deviceName.trim() || typeof input.password !== 'string' || !input.password || input.password.length > 128) throw failure('INVALID_INPUT', '请填写账号、密码和这台电脑的名称');
            if (register ? typeof input.code !== 'string' || !input.code : typeof input.username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(input.username)) throw failure('INVALID_INPUT', '请检查员工账号或一次性接入码');
            const fields = register ? { code: input.code, password: input.password } : { username: input.username, password: input.password };
            const result = await request('/v1/employee/' + (register ? 'register' : 'login'), 'POST', { ...fields, deviceName: input.deviceName.trim() }, undefined);
            try {
                const next = { serverURL, deviceId: result.deviceId, expiresAt: result.expiresAt, employee: result.employee, encryptedToken: await protection.encrypt(result.accessToken) };
                await writeFile(identityPath + '.tmp', JSON.stringify(next), { mode: 0o600 });
                await rename(identityPath + '.tmp', identityPath);
                identity = next; token = result.accessToken;
            } catch (error) {
                await request('/v1/employee/logout', 'POST', {}, result.accessToken).catch(() => { /* The failed device is never made available locally. */ });
                throw error;
            }
            return publicState();
        });
    }
    async function connectAgent(agentId, options = {}) {
            const boot = await bootstrap();
            if (!boot) throw failure('UNAUTHENTICATED', '请先登录公司账号');
            const agent = boot.agents.find(item => item.id === agentId);
            if (!agent) throw failure('PERMISSION_DENIED', '只能使用分配给本人的岗位');
            if (active?.lease.agentId === agentId && active.started && runtime.isReady?.() !== false && !active.released && !options.refresh) return publicState();
            if (active && !active.released) {
                let status;
                try { status = await request('/v1/harness/clients/' + active.lease.id); }
                catch (error) { if (![401, 404].includes(error.status)) throw error; }
                if (status?.lastRun?.state === 'running' && !options.stopActive) throw failure('WORK_RUNNING', '当前岗位仍有工作在执行，停止并核对结果后才能切换');
            }
            await retire();
            const lease = await request('/v1/harness/clients', 'POST', { agentId });
            const home = resolve(dataDir, 'harness', keyFor(boot.employee.companyId, boot.employee.id, agentId));
            active = { lease, home, ownerId:boot.employee.id,companyId:boot.employee.companyId,started: false, released: false, stopped:false };
            try {
                const presets = await request('/v1/presets');
                const preset = presets.find(item => item.id === lease.preset?.id && item.version === lease.preset?.version);
                if (!preset) throw failure('PRESET_UNAVAILABLE', '岗位预设不可用，请联系管理员');
                await runtime.start({ home, lease, preset }); active.started = true;
            }
            catch (error) { await retire(); throw error; }
            return publicState();
    }
    const selectAgent=(agentId,options={})=>exclusive(()=>connectAgent(agentId,options));
    async function logout() {
        return exclusive(async () => {
            await retire();
            if (token) {
                try { await request('/v1/employee/logout', 'POST', {}); }
                catch (error) { if (error.status !== 401) throw error; }
            }
            await removeIdentity(); return { authenticated: false, serverURL };
        });
    }
    return {
        async state() {
            if(closing)throw failure('CLIENT_CLOSING','公司客户端正在退出');
            while(busy){await transition;if(closing)throw failure('CLIENT_CLOSING','公司客户端正在退出');}
            return exclusive(publicState);
        }, login: input => login(input), register: input => login(input, true), selectAgent, logout,
        close() {
            if (closed) return Promise.resolve();
            if (closing) return closing;
            closing = (async () => {
                await transition;
                try { await retire({exitOnly:true}); closed = true; }
                catch(error) { closing = undefined; throw error; }
            })();
            return closing;
        },
        async workCenter() {
            return exclusive(async () => {
                const state = await publicState();
                if (!state.authenticated) throw failure('UNAUTHENTICATED', '请先登录公司账号');
                const entries = [['work','/v1/work'],['inbox','/v1/assistant/inbox'],['reminders','/v1/assistant/reminders'],['connections','/v1/connections'],['events','/v1/events']];
                const results = await Promise.allSettled(entries.map(([,path])=>request(path)));
                return { ...state, ...Object.fromEntries(results.map((result,index)=>[entries[index][0],result.status==='fulfilled'?{available:true,data:result.value}:{available:false,message:result.reason.message}])) };
            });
        },
        async action(kind, id, input) {
            return exclusive(async () => {
                if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(id)) throw failure('INVALID_INPUT', '记录编号无效');
                if (kind === 'read-task') return request('/v1/tasks/' + id);
                if(kind==='market-list')return request('/v1/market/releases?query='+encodeURIComponent(input?.query??''));
                if(kind==='market-release')return request('/v1/market/releases/'+id);
                if(kind==='market-submissions')return request('/v1/market/submissions');
                if(kind==='market-submit')return request('/v1/market/submissions','POST',input,token,60000);
                if(kind==='resource-index')return request('/v1/resources?query='+encodeURIComponent(input?.query??'')+(input?.domain?'&domain='+encodeURIComponent(input.domain):''));
                if(kind==='resource-read')return request('/v1/resources/'+id+'?offset='+Number(input?.offset??0)+(input?.version?'&version='+Number(input.version):''));
                if(kind==='resource-create')return request('/v1/resources','POST',input);
                if(kind==='resource-access')return request('/v1/resources/'+id+'/access','PUT',input);
                if(kind==='task-result')return request('/v1/tasks/'+id+'/result');
                if(kind==='experience-list')return request('/v1/experiences');
                if(kind==='experience-validate')return request('/v1/experiences/'+id+'/validate','POST',input);
                if(kind==='experience-submit')return request('/v1/experiences/'+id+'/submit','POST',input);
                if(['context-latest','context-history','context-read','context-usage','work-memory-read','work-memory-save','resource-notifications','resource-subscribe','resource-recall','experience-create','memory-domains'].includes(kind)){
                    if(!active?.started||active.released)throw failure('JOB_REQUIRED','请先进入自己的工作岗位');const agentId=active.lease.agentId;
                    if(kind==='memory-domains')return request('/v1/memory-domains');
                    if(kind==='context-latest')return request('/v1/agents/'+agentId+'/context-latest');
                    if(kind==='context-history')return request('/v1/agents/'+agentId+'/context-history');
                    if(kind==='context-read'){const record=await request('/v1/model-contexts/'+id);if(record.agentId!==agentId)throw failure('PERMISSION_DENIED','请选择该记录所属岗位');return record;}
                    if(kind==='context-usage')return request('/v1/agents/'+agentId+'/context-usage');
                    if(kind==='work-memory-read')return request('/v1/work/'+id+'/memory/'+agentId);
                    if(kind==='work-memory-save')return request('/v1/work/'+id+'/memory/'+agentId,'PUT',input);
                    if(kind==='resource-notifications')return request('/v1/agents/'+agentId+'/resource-notifications');
                    if(kind==='resource-subscribe')return request('/v1/agents/'+agentId+'/resource-subscriptions','POST',{resourceId:id,mode:'notify'});
                    if(kind==='resource-recall')return request('/v1/agents/'+agentId+'/recall','POST',input);
                    if(kind==='experience-create')return request('/v1/experiences','POST',{...input,agentId});
                }
                if(['market-installed','market-install','market-uninstall','skill-read','context-select'].includes(kind)){
                    if(!active?.started||active.released)throw failure('JOB_REQUIRED','请先进入自己的工作岗位');
                    const agentId=active.lease.agentId;
                    if(kind==='market-installed')return request('/v1/agents/'+agentId+'/market');
                    if(kind==='skill-read')return request('/v1/agents/'+agentId+'/skills/'+id+'?offset='+Number(input?.offset??0)+(input?.path?'&path='+encodeURIComponent(input.path):''));
                    if(kind==='context-select'){const result=await request('/v1/harness/clients/'+active.lease.id+'/context','PUT',input);active.context={resources:input.resources.map(ref=>({id:ref.id,version:ref.version})),...(input.workId?{workId:input.workId}:{})};return result;}
                    const result=await request('/v1/market/releases/'+id+(kind==='market-install'?'/install':'/uninstall'),'POST',{agentId,...(kind==='market-install'?{config:input?.config??{}}:{})});
                    // Keep the same per-job native home; replace the lease and descriptors after a mount change.
                    await connectAgent(agentId,{refresh:true});return result;
                }
                if (kind === 'review-work') return request('/v1/work/' + id + '/review','POST',input);
                if (kind === 'read-notice') return request('/v1/assistant/inbox/' + id + '/read','POST',{});
                if (['memory-list','memory-read','job-details','job-usage'].includes(kind)) {
                    // The renderer cannot choose another job or supply an API path.
                    if (!active?.started || active.released) throw failure('JOB_REQUIRED', '请先进入自己的工作岗位');
                    const agentId=active.lease.agentId;
                    if(kind==='job-details') {
                        const agents=await request('/v1/agents');
                        const agent=agents.find(item=>item.id===agentId);
                        if(!agent)throw failure('PERMISSION_DENIED','当前岗位已不可用，请刷新岗位');
                        return {id:agent.id,displayName:agent.displayName,allowedTools:agent.allowedTools??[],servicePermissions:agent.servicePermissions??[],plugins:(agent.plugins??[]).map(p=>({pluginId:p.pluginId,pluginVersion:p.pluginVersion})),pluginId:agent.pluginId,pluginVersion:agent.pluginVersion};
                    }
                    const path='/v1/agents/'+encodeURIComponent(agentId);
                    if(kind==='job-usage')return request(path+'/usage');
                    return request(path+'/memory'+(kind==='memory-read'?'/'+id:''));
                }
                const workReads={'read-work':'','work-history':'/history','work-control-state':'/control'};
                if(Object.hasOwn(workReads,kind))return request('/v1/work/'+id+workReads[kind]);
                if(kind==='work-action') {
                    if(typeof input?.actionId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/u.test(input.actionId))throw failure('INVALID_INPUT','动作编号无效');
                    return request('/v1/work/'+id+'/actions/'+input.actionId);
                }
                const workWrites={'work-control':'/control','work-reconcile':'/reconcile','work-continue':'/inputs'};
                if(Object.hasOwn(workWrites,kind))return request('/v1/work/'+id+workWrites[kind],'POST',input);
                throw failure('INVALID_INPUT', '不支持的公司操作');
            });
        },
    };
}
