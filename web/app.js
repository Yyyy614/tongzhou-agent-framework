import { api,entryEnabled } from './api.js';
import { h, icon, button, avatar, toast, field, empty } from './ui.js';
import { views } from './views.js';
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
function closeSidebar(){sidebar?.classList.remove('open');root.querySelector('[aria-label="打开导航"]')?.setAttribute('aria-expanded','false');}
function brand() { return h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('bot', 23)), h('div', {}, h('strong', {}, 'Agent 工作台'), h('small', {}, 'COMPANY FRAMEWORK'))); }
function login(errorMessage) {
    ++ticket; stopLive(); main = undefined;
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
    root.replaceChildren(h('div', { class: 'login-screen' }, h('section', { class: 'login-story' }, brand(), h('h1', {}, '让员工与 Agent，', h('br'), '在同一套规则下协作。'), h('p', {}, '配置岗位能力，维护独立记忆，查看真实的工作记录。把公司已有的能力，逐步连接起来。'), h('div', { class: 'login-points' }, h('span', {}, '统一插件标准'), h('span', {}, '独立记忆空间'), h('span', {}, '可追踪的每次执行'))), h('section', { class: 'login-main' }, h('div', { class: 'login-card' }, h('h2', {}, '打开管理工作空间'), h('p', {}, '在本机项目目录运行下面的命令，即可通过一次性入口自动登录。'), h('div', { class: 'command' }, h('code', {}, 'npm run console'), button(icon('copy', 16), async () => { await navigator.clipboard.writeText('npm run console'); toast('启动命令已复制'); }, 'icon-button', { 'aria-label': '复制启动命令' })), h('div', { class: 'login-divider' }, '或使用已有本地身份'), form, h('p', { class: 'login-foot' }, '登录身份来自框架内核。模型服务商密钥不用于管理后台登录。')))));
}
function shell() {
    nav = h('nav', { class: 'nav', 'aria-label': '管理后台导航' }, routes.map((route, i) => h('a', { href: '#' + route.id, class: state.page === route.id ? 'active' : '', 'data-route': route.id,onClick:closeSidebar }, icon(route.icon, 17), h('span', {}, route.name), route.count ? h('span', { class: 'nav-count', 'data-count': route.count }, '—') : null)));
    sidebar = h('aside', { class: 'sidebar',id:'workspace-navigation' }, brand(), h('div', { class: 'workspace-label' }, h('span', {}, h('i', { class: 'workspace-dot' }), '公司管理工作空间'), icon('down', 12)), h('p', { class: 'nav-label' }, 'WORKSPACE'), nav, h('div', { class: 'sidebar-bottom' }, h('div', { class: 'sidebar-status' }, h('strong', {}, h('span', { class: 'status-dot' }), '内核服务已连接'), h('p', {}, '框架测试环境 · Framework · 组织协作')), h('div', { class: 'account' }, avatar(me.displayName === 'admin' ? '管' : me.displayName, 'purple'), h('div', {}, h('strong', {}, me.displayName === 'admin' ? '管理员' : me.displayName), h('small', {}, me.id + ' · 管理员')), button(icon('logout', 17), async () => { await api('/console/logout', 'POST', {}); login(); }, 'icon-button', { 'aria-label': '退出登录' }))));
    breadcrumb = h('strong', {}, '工作空间');
    main = h('main', { class: 'main', id: 'main-content' });
    const topbar = h('header', { class: 'topbar' }, h('div', { class: 'breadcrumb' }, button(icon('menu', 19), event=>{const open=sidebar.classList.toggle('open');event.currentTarget.setAttribute('aria-expanded',String(open));}, 'icon-button mobile-menu', { 'aria-label': '打开导航','aria-controls':'workspace-navigation','aria-expanded':'false' }), h('span', {}, '管理后台'), icon('chevron', 12), breadcrumb), h('div', { class: 'top-actions' }, h('span', { class: 'env-label' }, h('span', { class: 'status-dot' }), '已连接工作空间'), button(icon('refresh', 16), () => refresh(), 'icon-button', { 'aria-label': '刷新页面' }), avatar('管', 'purple')));
    root.replaceChildren(h('div', { class: 'layout' }, sidebar, h('div', { class: 'main-shell' }, topbar, main)));
}
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
            state.page='work';main=h('main',{class:'main',id:'main-content'});
            root.replaceChildren(h('div',{class:'main-shell'},h('header',{class:'topbar'},h('strong',{},'公司 Agent · 工作中心'),h('span',{},me.displayName+' · 授权工作中心'),...(entryEnabled?[button('我的工作',()=>{state.page='work';void renderWorkCenter();},'secondary'),button('连接机器人',()=>{state.page='entries';void renderWorkCenter();},'secondary')]:[]),button('退出当前账号',async()=>{await api('/console/logout','POST',{});login();},'secondary')),main));
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

window.addEventListener('keydown',event=>{if(event.key==='Escape')closeSidebar();});



