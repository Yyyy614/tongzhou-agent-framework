import { resultView } from './result-view.mjs';
const content = document.querySelector('#content'), error = document.querySelector('#error'), status = document.querySelector('#status');
const entry = new URLSearchParams(location.hash.slice(1)).get('session');
if (entry) { sessionStorage.setItem('client-session', entry); history.replaceState(null, '', '/'); }
const session = entry ?? sessionStorage.getItem('client-session');
const desktopShell = new URLSearchParams(location.hash.slice(1)).get('desktop') === '1' || !!window.chrome?.webview;
let firstDesktopLoad = desktopShell;
const nativeOpened = info => { if (desktopShell && info.started) window.chrome?.webview?.postMessage(JSON.stringify({ type: 'harness.opened', processId: info.processId })); };
// A launcher can reuse a tab at the same loopback origin after a process restart.
// A new fragment must bootstrap a new document, rather than keep the old ticket.
window.addEventListener('hashchange', () => { if (new URLSearchParams(location.hash.slice(1)).has('session')) location.reload(); });
const element = (tag, text, attrs = {}) => { const node = document.createElement(tag); if (text) node.textContent = text; Object.assign(node, attrs); return node; };
const button = (text, action, primary = false) => { const node = element('button', text, { type: 'button', className: primary ? 'primary' : '' }); node.addEventListener('click', () => work(action)); return node; };
let busy = false, mode = 'login', assistantGeneration = 0, assistantTimer;
async function request(path, body) {
    const response = await fetch('/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-client-session': session ?? '', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error.message);
    return result;
}
async function work(action) { if (busy) return; busy = true; error.hidden = true; document.querySelectorAll('button,input,select').forEach(n => n.disabled = true); try { await action(); } catch (e) { error.textContent = e.message; error.hidden = false; } finally { busy = false; document.querySelectorAll('button,input,select').forEach(n => n.disabled = false); } }
async function refresh() {
    const generation = ++assistantGeneration;
    clearTimeout(assistantTimer);
    let state = await request('state');
    if (firstDesktopLoad && state.authenticated && state.agents.length === 1) {
        firstDesktopLoad = false;
        try { nativeOpened(await request('open-default', {})); state = await request('state'); } catch (e) { error.textContent = e.message; error.hidden = false; }
    }
    content.replaceChildren(); status.textContent = state.authenticated ? '已连接' : '请登录';
    if(state.clientVersion) document.querySelector('header small').textContent='公司软件 '+state.clientVersion;
    if (!state.authenticated) {
        const register = mode === 'register';
        const code = element('input', '', { type: 'password', required: true, autocomplete: 'off', id: 'activation-code' });
        const username = element('input', '', { required: true, autocomplete: 'username', maxLength: 64, id: 'employee-username' });
        const password = element('input', '', { type: 'password', required: true, minLength: register ? 12 : 1, maxLength: 128, autocomplete: register ? 'new-password' : 'current-password', id: 'employee-password' });
        const repeat = element('input', '', { type: 'password', required: true, minLength: 12, maxLength: 128, autocomplete: 'new-password', id: 'password-repeat' });
        const device = element('input', '', { required: true, value: '我的工作电脑', maxLength: 80, id: 'device-name' });
        const form = element('form');
        form.append(element('h1', register ? '首次接入 / 重置密码' : '登录你的工作 Agent'), element('p', register ? '使用管理员给的一次性接入码设置密码，密码为12至128个字符。重置密码会让之前登录的设备退出。' : state.expired ? '这台电脑的登录已失效，请用账号密码重新登录。' : '输入管理员分配的员工账号和你设置的密码。换电脑后仍可使用自己的岗位和记忆。'), element('div', state.serverURL, { className: 'info' }));
        if (register) form.append(element('label', '一次性接入码', { htmlFor: code.id }), code);
        else form.append(element('label', '员工账号', { htmlFor: username.id }), username);
        form.append(element('label', register ? '设置登录密码' : '登录密码', { htmlFor: password.id }), password);
        if (register) form.append(element('label', '再次输入密码', { htmlFor: repeat.id }), repeat);
        form.append(element('label', '这台电脑的名称', { htmlFor: device.id }), device);
        const actions = element('div', '', { className: 'actions' });
        actions.append(element('button', register ? '设置密码并登录' : '登录', { type: 'submit', className: 'primary' }), button(register ? '返回账号登录' : '首次接入 / 重置密码', async () => { mode = register ? 'login' : 'register'; await refresh(); })); form.append(actions);
        if (state.harnessOpen) actions.append(button('关闭已失效的 Harness', async () => { await request('close', {}); await refresh(); }));
        form.addEventListener('submit', event => { event.preventDefault(); void work(async () => { if (register && password.value !== repeat.value) throw Error('两次输入的密码不一致。'); const credentials = register ? { code: code.value.trim(), password: password.value } : { username: username.value.trim(), password: password.value }; const boot = await request(register ? 'register' : 'login', { ...credentials, deviceName: device.value.trim() }); code.value = password.value = repeat.value = ''; mode = 'login'; firstDesktopLoad = false; if (boot.agents?.length === 1) { try { nativeOpened(await request('open-default', {})); } catch (e) { await refresh(); throw e; } } await refresh(); }); });
        content.append(form, element('p', '员工编号就是登录账号。密码不会保存在客户端；本机只保存当前 Windows 用户保护的设备凭证。忘记密码请联系管理员签发新的接入码。', { className: 'note' }));
        return;
    }
    content.append(element('h1', '你好，' + state.employee.displayName), element('p', '选择自己的工作岗位，在 Harness 中开始工作。'), element('div', state.employee.id + ' · ' + state.serverURL, { className: 'info' }));
    const select = element('select', '', { id: 'agent-choice' });
    for (const agent of state.agents) select.append(element('option', agent.displayName + ' · ' + agent.presetName, { value: agent.id }));
    content.append(element('label', '分配给你的岗位', { htmlFor: select.id }), select);
    if (!state.agents.length) content.append(element('p', '目前没有可用岗位，请联系管理员检查分配、预设和插件状态。'));
    const actions = element('div', '', { className: 'actions' });
    actions.append(button('打开我的工作台', async () => { if (!select.value) throw Error('请先分配一个有效岗位。'); nativeOpened(await request('open', { agentId: select.value })); status.textContent = '工作台已打开'; }, true), button('关闭工作台', async () => { await request('close', {}); await refresh(); }), button('刷新岗位', refresh), button('退出登录', async () => { if (!confirm('将退出这台电脑，之后可用账号密码重新登录。确定退出吗？')) return; await request('logout', {}); await refresh(); }));
    content.append(actions, element('p', '管理员调整权限或岗位后，请关闭并重新打开 Harness。其他同事的私人记忆不会加载到你的岗位。', { className: 'note' }));
    const catalog = element('details'); catalog.append(element('summary','公司接口与配置说明')); const catalogBody=element('div');catalog.append(catalogBody);content.append(catalog);
    catalog.addEventListener('toggle',async()=>{if(!catalog.open)return;try{const data=await request('connections');catalogBody.replaceChildren(...data.items.map(c=>{const card=element('article','',{className:'info'});card.append(element('h3',c.name),element('p',(c.kind==='model'?'模型渠道':'插件接口')+' · '+c.protocol),element('p',c.documentation||'管理员尚未补充说明。'),element('p','连接引用：connection:'+c.id));return card;}));}catch{catalogBody.textContent='暂时无法读取授权接口目录。';}});
    const updates = element('section');
    const drafts = new Map(), taskResults = new Map();
    content.append(element('h2', '我的工作与提醒'), updates);
    async function updateAssistant(force = false) {
        if (generation !== assistantGeneration) return;
        clearTimeout(assistantTimer);
        if (force || !document.hidden && !busy && !updates.contains(document.activeElement)) {
            const settled = await Promise.allSettled([request('work'), request('inbox'), request('reminders')]);
            if (generation !== assistantGeneration) return;
            const list = element('div');
            const labels = { queued: '排队中', running: '执行中', succeeded: '已完成', failed: '执行失败', reconciliation_required: '结果待核实', waiting_approval: '等待授权', waiting_review: '等待核对', completed: '已核对完成', needs_attention: '需要处理', changes_requested: '需要调整', pending: '等待提醒', delivered: '已送达', cancelled: '已取消' };
            for (const [i, title] of ['协作工作', '本人通知', '工作提醒'].entries()) {
                list.append(element('h3', title));
                const result = settled[i];
                if (result.status === 'rejected') { list.append(element('p', '暂不可用或未授予此项权限。', { className: 'note' })); continue; }
                if (!result.value.length) list.append(element('p', '暂无记录', { className: 'note' }));
                for (const item of result.value.slice(0, 20)) {
                    const card = element('article', '', { className: 'info' });
                    card.append(element('strong', item.title ?? item.data?.title ?? item.kind), element('p', item.state ? labels[item.state] ?? item.state : item.readAt ? '已读' : '未读'));
                    if (i === 0) {
                        for (const a of item.assignments) {
                            const name = a.agentName ?? '岗位助手', names = { [a.agentId]: name, [a.ownerId]: a.ownerName ?? '负责同事' };
                            card.append(element('h4', name + ' · ' + (labels[a.state] ?? '需要查看') + (a.ownerName ? ' · ' + a.ownerName : '')));
                            if (a.summary && !taskResults.has(a.taskId)) card.append(resultView(a.summary, { names }));
                            card.append(button('查看完整结果 · ' + name, async () => { const result = await request('tasks/' + a.taskId); taskResults.set(a.taskId, result); await updateAssistant(true); }));
                            if (taskResults.has(a.taskId)) { const result = taskResults.get(a.taskId); card.append(resultView(result.output ?? result.error?.code ?? '暂无结果', { names, technical: result })); }
                        }
                        if (item.canReview) {
                            const draft = drafts.get(item.id) ?? { reason: '', decision: 'approve' }; drafts.set(item.id, draft);
                            const decision = element('select', '', { 'aria-label': '核对决定' });
                            decision.append(element('option', '结果符合要求', { value: 'approve' }), element('option', '结果需要调整', { value: 'reject' })); decision.value = draft.decision;
                            decision.setAttribute('aria-label', '核对决定'); decision.addEventListener('change', () => draft.decision = decision.value);
                            const reason = element('textarea', '', { value: draft.reason, rows: 3, maxLength: 1000, placeholder: '核对各岗位完整结果后，填写依据。' }); reason.setAttribute('aria-label', '核对说明'); reason.addEventListener('input', () => draft.reason = reason.value);
                            card.append(element('p', '负责人核对：这是工作结果验收，业务发布仍需对应审批。'), decision, reason, button('提交人工核对', async () => { if (!reason.value.trim()) throw Error('请先填写核对依据。'); await request('work/' + item.id + '/review', { revision: item.revision, decision: decision.value, reason: reason.value.trim() }); drafts.delete(item.id); await updateAssistant(true); }, true));
                        }
                    }
                    const text = item.details ?? item.data?.details;
                    if (text) card.append(element('p', text));
                    const dueAt = item.dueAt ?? item.data?.dueAt;
                    if (dueAt) card.append(element('p', '时间：' + new Date(dueAt).toLocaleString()));
                    const ref = item.subjectRef ?? item.data?.subjectRef;
                    if (ref) { const details = element('details'); details.append(element('summary', '关联记录'), element('p', ref.system + ' / ' + ref.id)); card.append(details); }
                    if (i === 1 && !item.readAt) card.append(button('标记已读', async () => { await request('inbox/' + item.id + '/read', {}); await updateAssistant(true); }));
                    list.append(card);
                }
            }
            updates.replaceChildren(list);
        }
        if (generation === assistantGeneration) assistantTimer = setTimeout(updateAssistant, 5000);
    }
    assistantTimer = setTimeout(updateAssistant, 100);
}
void work(refresh);
