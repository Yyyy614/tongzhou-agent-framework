import{productName,brandMark}from './brand.mjs';
import { api,entryEnabled } from './api.js';
import { h, icon, button, avatar, toast, field, empty } from './ui.js';
import { views as baseViews } from './base-views.js';
import { studioOverview } from './studio-overview.js';
import { studioEmployeeShell } from './studio-employee.js';
import { studioShell,searchWorkspace } from './studio-shell.js';
const views={...baseViews,overview:studioOverview};
const root = document.querySelector('#app');
const routes = [{id:'channels',name:'渠道与接口',icon:'box'},{ id: 'organization', name: '组织与权限', icon: 'people' }, { id: 'work', name: '协作工作', icon: 'activity' }, { id: 'assistant', name: '工作辅助 Bot', icon: 'bot' }, { id: 'overview', name: '工作空间', icon: 'grid' }, { id: 'employees', name: '员工管理', icon: 'people', count: 'employees' }, { id: 'agents', name: 'Agent 管理', icon: 'bot', count: 'agents' }, { id: 'plugins', name: '插件与能力', icon: 'box', count: 'plugins' }, { id: 'memory', name: '独立记忆', icon: 'brain' }, { id: 'logs', name: '日志与记录', icon: 'activity' }, { id: 'usage', name: '模型用量', icon: 'chart' }];
const state = { page: 'overview', memoryAgentId: null, memoryNotes: {}, memoryMode: 'edit', logs: {}, usage: {} };
if(entryEnabled)routes.unshift({id:'entries',name:'外部机器人与 CLI',icon:'bot'});
let me, employees = [], agents = [], plugins = [], main, sidebar, breadcrumb, nav;
let ticket = 0;
let liveView, preferenceKey;
function persistState() {
    if (!preferenceKey) return;
    const { memoryAgentId, memoryNotes, memoryMode, logs, usage } = state;
    try { sessionStorage.setItem(preferenceKey, JSON.stringify({ memoryAgentId, memoryNotes, memoryMode, logs, usage })); } catch { }
}
function restoreState() {
    preferenceKey = 'company-framework:console-view:' + me.companyId + ':' + me.id;
    let saved = {};
    try { const raw = sessionStorage.getItem(preferenceKey); if (raw?.length < 12000) saved = JSON.parse(raw) ?? {}; } catch { }
    const text = (value, max = 80) => typeof value === 'string' ? value.slice(0, max) : '';
    state.memoryAgentId = text(saved.memoryAgentId, 64) || null;
    state.memoryMode = saved.memoryMode === 'preview' ? 'preview' : 'edit';
    state.memoryNotes = Object.fromEntries(Object.entries(saved.memoryNotes && typeof saved.memoryNotes === 'object' ? saved.memoryNotes : {}).filter(([key, value]) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(key) && typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value)));
    state.logs = { agentId: text(saved.logs?.agentId, 64), q: text(saved.logs?.q, 200), type: text(saved.logs?.type), before: text(saved.logs?.before, 40) || null };
    state.usage = { days: ['7', '30', '90'].includes(saved.usage?.days) ? saved.usage.days : '7', agentId: text(saved.usage?.agentId, 64), principalId: text(saved.usage?.principalId, 64) };
}
function stopLive() { liveView?.dispose(); liveView = undefined; }
function closeSidebar(){sidebar?.classList.remove('open');root.querySelector('[aria-controls="workspace-navigation"]')?.setAttribute('aria-expanded',String(innerWidth>=760));}
function brand() { return h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, h('img',{src:brandMark,alt:''})), h('div', {}, h('strong', {}, productName), h('small', {}, '团队工作台'))); }
function login(errorMessage) {
    ++ticket; stopLive();document.querySelectorAll('dialog').forEach(d=>d.close());main = undefined;
    const token = h('input', { type: 'password', required: true, autocomplete: 'off', placeholder: '粘贴本地账号访问令牌' });
    const error = h('div', { class: 'form-error', hidden: !errorMessage, role: 'alert' }, errorMessage ?? '');
    const submit = h('button', { class: 'button primary', type: 'submit' }, '进入工作空间', icon('arrow', 15));
    const form = h('form', { onSubmit: async (event) => { event.preventDefault(); submit.disabled = true; error.hidden = true; try {
            await api('/console/login', 'POST', { accessToken: token.value });
            token.value = '';
            await start();
        }
        catch (e) {
            error.textContent = e.message;
            error.hidden = false;
        }
        finally {
            submit.disabled = false;
        } } }, field('访问令牌', token), submit, error);
    root.replaceChildren(h('div', { class: 'login-screen' }, h('section', { class: 'login-story' }, brand(), h('h1', {}, '让员工与 Agent，', h('br'), '在同一套规则下协作。'), h('p', {}, '配置岗位能力，维护独立记忆，查看真实的工作记录。把公司已有的能力，逐步连接起来。'), h('div', { class: 'login-points' }, h('span', {}, '统一插件标准'), h('span', {}, '独立记忆空间'), h('span', {}, '可追踪的每次执行'))), h('section', { class: 'login-main' }, h('div', { class: 'login-card' }, h('h2', {}, '打开管理工作空间'), h('p', {}, '在本机项目目录运行下面的命令，即可通过一次性入口自动登录。'), h('div', { class: 'command' }, h('code', {}, 'npm run console:studio'), button(icon('copy', 16), async () => { await navigator.clipboard.writeText('npm run console:studio'); toast('启动命令已复制'); }, 'icon-button', { 'aria-label': '复制启动命令' })), h('div', { class: 'login-divider' }, '或使用已有本地身份'), form, h('p', { class: 'login-foot' }, '登录身份来自框架内核。模型服务商密钥不用于管理后台登录。')))));
}
function openSearch(){if(main&&me?.role==='admin')searchWorkspace({routes,employees,agents,navigate,state});}
function shell(){({nav,sidebar,breadcrumb,main}=studioShell({me,state,routes,root,brand,closeSidebar,refresh,search:openSearch,logout:async()=>{await api('/console/logout','POST',{});login();}}));}
async function refresh() { if (liveView) return liveView.refresh(); return render(); }
async function renderWorkCenter(){
    stopLive();const current=++ticket;let candidateLive;
    try{
        const team=await api('/v1/team');if(current!==ticket)return;
        const ctx={me,employees:team.members,agents:team.agents,departments:team.departments,plugins:[],presets:[],state,canDispatch:false,refresh:renderWorkCenter,navigate:page=>{if(['work','entries'].includes(page)){state.page=page;void renderWorkCenter();}},isCurrent:()=>current===ticket,registerLive:controller=>{candidateLive=controller;},sessionExpired:error=>login(error.message)};
        const view=await(state.page==='entries'&&entryEnabled?views.entries:views.work)(ctx);if(current!==ticket){candidateLive?.dispose();return;}
        main.replaceChildren(view);liveView=candidateLive;liveView?.start();
    }catch(error){candidateLive?.dispose();if(current===ticket){if(error.code==='UNAUTHENTICATED')login(error.message);else main.replaceChildren(empty('无法读取授权工作',error.message));}}
}
async function render() {
    stopLive();
    const current = ++ticket;
    let candidateLive;
    main.replaceChildren(h('div', { class: 'loading-state' }, h('span', { class: 'loader' }), '正在读取内核记录…'));
    try {
        const [loadedEmployees, loadedAgents, loadedPlugins, presets, departments] = await Promise.all([api('/v1/admin/employees'), api('/v1/admin/agents'), api('/v1/admin/plugins'), api('/v1/presets'), api('/v1/admin/departments')]);
        [employees, agents, plugins] = [loadedEmployees, loadedAgents, loadedPlugins];
        if (current !== ticket)
            return;
        const ctx = { me, employees, agents, plugins, presets, departments, state, refresh, navigate, persistState, isCurrent: () => current === ticket, registerLive: controller => { candidateLive?.dispose(); candidateLive = controller; }, sessionExpired: error => login(error.message) };
        const view = await views[state.page](ctx);
        if (current !== ticket) { candidateLive?.dispose(); return; }
        main.replaceChildren(view);
        liveView = candidateLive;
        liveView?.start();
        for (const route of routes) {
            const link = nav.querySelector('[data-route="' + route.id + '"]');
            link.classList.toggle('active', route.id === state.page);
            if (route.count) {
                link.querySelector('.nav-count').textContent = String({ employees, agents, plugins }[route.count].length);
            }
        }
        breadcrumb.textContent = routes.find(r => r.id === state.page).name;
    }
    catch (error) {
        candidateLive?.dispose();
        if (current !== ticket)
            return;
        if (error.code === 'UNAUTHENTICATED') {
            login(error.message);
            return;
        }
        main.replaceChildren(empty('暂时无法读取记录', error.message, button('重新连接', refresh, 'primary')));
    }
}
function navigate(page) { if (!views[page])
    page = 'overview'; sidebar?.classList.remove('open'); if (location.hash === '#' + page) {
    state.page = page;
    void render();
}
else
    location.hash = page; }
async function start() {
    try {
        const entry = new URLSearchParams(location.hash.slice(1)).get('entry');
        if (entry) {
            history.replaceState(null, '', location.pathname);
            await api('/console/login', 'POST', { code: entry });
        }
        me = await api('/console/me');
        if (me.role !== 'admin') {
            state.page=location.hash==='#entries'&&entryEnabled?'entries':'work';
            main=studioEmployeeShell({root,me,state,entryEnabled,navigate:page=>{state.page=page;void renderWorkCenter();},logout:async()=>{await api('/console/logout','POST',{});login();}});
            await renderWorkCenter();
            return;
        }
        restoreState();
        const page = location.hash.slice(1);
        state.page = views[page] ? page : 'overview';
        shell();
        await refresh();
    }
    catch (error) {
        login(error.code === 'UNAUTHENTICATED' ? undefined : error.message);
    }
}
window.addEventListener('hashchange', () => { if (!main||me?.role!=='admin')
    return; const page = location.hash.slice(1); if (views[page]) {
    state.page = page;
    sidebar.classList.remove('open');
    void render();
} });
window.addEventListener('unhandledrejection', event => { event.preventDefault(); toast(event.reason?.message ?? '操作未完成', 'danger'); });
void start();

window.addEventListener('keydown',event=>{if(event.key==='Escape')closeSidebar();if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openSearch();}});



