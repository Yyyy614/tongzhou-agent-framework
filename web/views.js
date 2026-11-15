import { employeeAccess } from './employee-access.js';
import { organizationView, workView, assistantView } from './coordination-views.js';
import { channelsView } from './channels-view.js';
import { api, idempotency } from './api.js';
import { h, icon, button, badge, activeBadge, stateBadge, nameCell, avatar, number, date, table, empty, toast, field, select, modal, details, searchInput, heading, panel, metric, chart, confirm, liveRefresh } from './ui.js';
import { editEmployee, toggleEmployee, editAgent, mountPlugin, showBindings, installPlugin, validatePlugin, togglePlugin, runDialog, agentBody, toggleAgent } from './editors.js';
const actorName = (ctx, id) => ctx.employees.find(e => e.id === id)?.displayName ?? id;
const agentName = (ctx, id) => ctx.agents.find(a => a.id === id)?.displayName ?? id;
const bindings = a => [{ pluginId: a.pluginId, pluginVersion: a.pluginVersion }, ...(a.plugins ?? [])];
const events = { 'tool.succeeded': '插件工具完成', 'tool.rejected': '工具调用未通过', 'runtime.tool_succeeded': 'Agent 工具完成', 'runtime.tool_failed': 'Agent 工具失败', 'memory.updated': '记忆已更新', 'run.started': 'Agent 开始工作', 'run.succeeded': 'Agent 工作完成', 'run.failed': 'Agent 工作失败', 'run.cancelled': 'Agent 已取消', 'run.reconciliation_required': '运行需要核对', 'report.recorded': '工作报告已提交', 'feedback.recorded': '反馈已记录', 'release.applied': '岗位版本已切换', 'employee.created': '创建员工', 'employee.updated': '更新员工', 'agent.created': '创建 Agent', 'agent.updated': '更新 Agent', 'admin.tool_test': '管理员发起验证', 'console.login': '后台登录', 'task.queued': '任务进入队列', 'task.failed': '任务结束异常', 'approval.granted': '写操作已批准', 'preferences.updated': '个人偏好已更新' };
const eventCell = type => h('div', { class: 'event-name' }, events[type] ?? type, h('span', { class: 'event-raw mono' }, type));
const go = (ctx, page, agentId) => { if (agentId)
    ctx.state.memoryAgentId = agentId; ctx.navigate(page); };
const notify = promise => promise.catch(error => toast(error.message, 'danger'));
export async function overviewView(ctx) {
    const [overview, usage] = await Promise.all([api('/v1/admin/overview'), api('/v1/admin/usage?days=7')]);
    const c = overview.counts;
    const metrics = h('div', { class: 'metrics' }, metric('员工账号', c.employees, c.activeEmployees + ' 个账号已启用', 'people'), metric('岗位 Agent', c.agents, c.activeAgents + ' 个岗位已启用', 'bot'), metric('已安装插件', c.plugins, '能力包按精确版本管理', 'box'), metric('模型调用', usage.totals.requests, '近 7 日 · ' + number(usage.totals.inputTokens + usage.totals.outputTokens) + ' tokens', 'activity'));
    const quickItems = [{ icon: 'people', title: '添加员工', sub: '建立独立身份与能力授权', action: () => editEmployee(ctx) }, { icon: 'bot', title: '创建岗位 Agent', sub: '绑定负责人和工作职责', action: () => editAgent(ctx) }, { icon: 'box', title: '配置插件能力', sub: '把已有工具挂载到指定岗位', action: () => go(ctx, 'plugins') }, { icon: 'brain', title: '管理独立记忆', sub: '维护索引，只读取工作需要的内容', action: () => go(ctx, 'memory') }];
    const quick = panel('快速开始', '从一次真实操作开始验证框架', h('div', { class: 'quick-actions' }, quickItems.map(item => h('button', { class: 'quick-item', onClick: item.action }, h('span', { class: 'quick-icon' }, icon(item.icon)), h('span', {}, h('strong', {}, item.title), h('small', {}, item.sub)), h('span', { class: 'chevron' }, icon('chevron', 15))))));
    const recent = table([{ label: '岗位 / 负责人', render: r => nameCell(agentName(ctx, r.agentId), actorName(ctx, r.principalId)) }, { label: '工作状态', render: r => stateBadge(r.state) }, { label: '最近更新', render: r => h('span', { class: 'log-time' }, date(r.createdAt)) }], overview.recentRuns, { empty: '还没有 Agent 运行记录，点击「运行验证」开始。', onRow: r => details('运行记录', r) });
    const channels = h('div', { class: 'integration-list' }, overview.channels.map(channel => h('div', { class: 'integration-item' }, h('strong', {}, channel.name), badge('尚未接入'), h('p', { class: 'field-hint' }, '后续通过渠道适配器连接'))));
    return h('div', {}, heading('工作空间总览', '人员、能力与工作记录，在同一个地方协同。', button([icon('play', 15), '运行验证'], () => runDialog(ctx), 'primary')), metrics, h('div', { class: 'dashboard-grid' }, panel('模型用量趋势', '近 7 日 · 服务商实测与远程上报分开记录', chart(usage.series), badge('实时数据', 'success')), quick), h('div', { class: 'dashboard-grid overview-bottom' }, panel('最近工作', '来自内核持久化的真实运行记录', recent, button('全部日志', () => go(ctx, 'logs'), 'text')), panel('协作平台', '渠道独立适配，统一复用公司权限', channels)), h('div', { class: 'runtime-banner' }, h('div', { class: 'button-row' }, h('span', { class: 'runtime-icon' }, icon('shield', 22)), h('div', {}, h('h3', {}, 'DeepSeek Harness 执行内核'), h('p', {}, '独立记忆 · 受控工具 · 用量留痕 · 按岗位配置'))), h('div', { class: 'button-row' }, badge('内核已连接', 'success'), h('span', { class: 'mono muted' }, 'v' + overview.version))), h('p', { class: 'footer-note' }, '当前为框架测试工作空间 · 页面数据来自正在运行的框架内核'));
}
export async function employeesView(ctx) {
    const body = h('div');
    let query = '', department = '';
    const render = () => { const rows = ctx.employees.filter(e => (!department || e.department === department) && [e.id, e.displayName, e.department].some(s => String(s ?? '').toLowerCase().includes(query.toLowerCase()))); body.replaceChildren(table([{ label: '员工', render: e => nameCell(e.displayName ?? e.id, e.id, e.role === 'admin' ? 'purple' : 'blue') }, { label: '所属部门', render: e => e.department ? h('span', { class: 'chip' }, e.department) : h('span', { class: 'muted' }, '未分配') }, { label: '角色', render: e => badge(e.role === 'admin' ? '管理员' : '员工', e.role === 'admin' ? 'primary' : 'neutral') }, { label: '负责 Agent', render: e => h('span', {}, ctx.agents.filter(a => a.ownerId === e.id).length + ' 个') }, { label: '账号状态', render: e => activeBadge(e.active) }, { label: '操作', render: e => h('div', { class: 'button-row' }, button('编辑', () => editEmployee(ctx, e), 'text'), button('员工接入', () => employeeAccess(ctx, e), 'text', { disabled: e.role !== 'employee' }), button(e.active ? '停用' : '启用', () => toggleEmployee(ctx, e), 'text', { disabled: e.id === ctx.me.id, title: e.id === ctx.me.id ? '当前管理员账号保持启用' : undefined })) }], rows, { empty: '没有找到匹配的员工。' }), h('div', { class: 'table-footer' }, h('span', {}, '共 ' + rows.length + ' 位员工'), h('span', {}, '权限在每次执行时重新检查'))); };
    const search = searchInput('搜索姓名、编号或部门', event => { query = event.target.value; render(); });
    const departments = [...new Set(ctx.employees.map(e => e.department).filter(Boolean))];
    const filter = select([{ value: '', label: '全部部门' }, ...departments.map(d => ({ value: d, label: d }))], '', e => { department = e.target.value; render(); }, { 'aria-label': '筛选部门' });
    render();
    return h('div', {}, heading('员工管理', '为每位员工配置独立身份、职责范围与可使用的能力。', button([icon('plus', 16), '新增员工'], () => editEmployee(ctx), 'primary')), h('section', { class: 'panel' }, h('div', { class: 'toolbar' }, h('div', { class: 'toolbar-left' }, search, filter), h('span', { class: 'count-label' }, ctx.employees.filter(e => e.active).length + ' 位员工已启用')), body));
}
export async function agentsView(ctx) {
    const cards = h('div', { class: 'agent-grid' });
    let query = '';
    const render = () => { const agents = ctx.agents.filter(a => [a.id, a.displayName, actorName(ctx, a.ownerId)].some(s => String(s ?? '').toLowerCase().includes(query.toLowerCase()))); cards.replaceChildren(...agents.map(a => h('article', { class: 'agent-card' }, h('div', { class: 'card-body' }, h('div', { class: 'card-top' }, h('span', { class: 'card-icon' }, icon('bot', 23)), activeBadge(a.active)), h('h2', { class: 'card-title' }, a.displayName ?? a.id), h('span', { class: 'sub-id' }, a.id), h('div', { class: 'card-owner' }, avatar(actorName(ctx, a.ownerId)), h('span', {}, actorName(ctx, a.ownerId))), h('div', { class: 'chips' }, bindings(a).slice(0, 3).map(b => h('span', { class: 'chip', title: b.pluginId + '@' + b.pluginVersion }, b.pluginId.split('/').at(-1) + ' · ' + b.pluginVersion))), h('div', { class: 'card-stats' }, h('span', {}, bindings(a).length + ' 个插件'), h('span', {}, a.effectiveTools.length + '/' + a.allowedTools.length + ' 项工具可用'), h('span', {}, '独立记忆'))), h('footer', { class: 'card-footer' }, h('div', { class: 'button-row' }, button('配置', () => editAgent(ctx, a), 'text'), button('插件', () => showBindings(ctx, a), 'text'), button('记忆', () => go(ctx, 'memory', a.id), 'text'), button(a.active ? '停用' : '启用', () => toggleAgent(ctx, a), 'text')), button([icon('play', 12), '验证'], () => runDialog(ctx, a.id), 'secondary small', { disabled: !a.active }))))); if (!agents.length)
        cards.append(empty('尚无匹配的 Agent', '创建岗位，绑定负责人，再配置插件与独立记忆。', button('创建 Agent', () => editAgent(ctx), 'primary'))); };
    render();
    return h('div', {}, heading('Agent 管理', '每个岗位独立配置、独立记忆，共享统一的运行规则。', button([icon('plus', 16), '创建 Agent'], () => editAgent(ctx), 'primary')), h('div', { class: 'section-toolbar' }, searchInput('搜索 Agent 名称或负责人', e => { query = e.target.value; render(); }), h('span', { class: 'count-label' }, ctx.agents.length + ' 个岗位 Agent')), cards);
}
export async function pluginsView(ctx) {
    const cards = h('div', { class: 'plugin-grid' });
    let query = '';
    const render = () => { const plugins = ctx.plugins.filter(p => p.id.toLowerCase().includes(query.toLowerCase())); cards.replaceChildren(...plugins.map(p => { const count = ctx.agents.filter(a => bindings(a).some(b => b.pluginId === p.id && b.pluginVersion === p.version)).length; return h('article', { class: 'plugin-card' }, h('div', { class: 'card-body' }, h('div', { class: 'card-top' }, h('span', { class: 'card-icon' }, icon('box', 24)), activeBadge(p.enabled)), h('h2', { class: 'card-title' }, p.id), h('p', { class: 'muted' }, '版本 ' + p.version + ' · ' + p.tools.length + ' 项工具'), h('div', { class: 'chips space-top' }, p.tools.map(t => h('span', { class: 'chip' }, t.id))), h('div', { class: 'card-stats' }, h('span', {}, '已挂载 ' + count + ' 个 Agent'), h('span', { class: 'mono', title: p.digest }, p.digest.slice(0, 10)))), h('div', { class: 'card-footer' }, h('div', { class: 'button-row' }, button('验证', () => validatePlugin(p), 'text', { disabled: !p.enabled }), button(p.enabled ? '停用' : '启用', () => togglePlugin(ctx, p), 'text')), button('挂载到 Agent', () => mountPlugin(ctx, p), 'secondary small', { disabled: !p.enabled }))); })); if (!plugins.length)
        cards.append(empty('没有匹配的插件', '安装符合框架格式的已审查插件包，即可挂载使用。')); };
    render();
    return h('div', {}, heading('插件与能力', '一次适配，按需挂载；每个岗位固定自己的插件版本。', button([icon('plus', 16), '安装插件'], () => installPlugin(ctx), 'primary')), h('div', { class: 'section-toolbar' }, searchInput('搜索插件名称', e => { query = e.target.value; render(); }), h('span', { class: 'count-label' }, ctx.plugins.length + ' 个已安装版本')), cards, h('div', { class: 'notice space-top' }, icon('shield'), h('span', {}, '安装只登记能力包；挂载和员工授权同时满足后，工具才可执行。插件更新不会自动覆盖其他岗位。')));
}
function markdown(text, onLink) { return h('div', { class: 'markdown-preview' }, text.split('\n').map(line => { if (line.startsWith('# '))
    return h('h2', {}, line.slice(2)); if (line.startsWith('## '))
    return h('h3', {}, line.slice(3)); const nodes = []; let offset = 0; for (const match of line.matchAll(/\[\[([A-Za-z0-9_-]+)\]\]/gu)) {
    nodes.push(line.slice(offset, match.index), h('button', { class: 'note-link', type: 'button', onClick: () => onLink(match[1]) }, match[1]));
    offset = match.index + match[0].length;
} nodes.push(line.slice(offset)); return h('div', {}, nodes.length ? nodes : '\u00a0'); })); }
export async function memoryView(ctx) {
    if (!ctx.agents.length)
        return h('div', {}, heading('独立记忆', '按 Agent 组织笔记和索引。'), empty('先创建一个 Agent', '每个岗位拥有独立记忆空间。', button('创建 Agent', () => editAgent(ctx), 'primary')));
    let selected = ctx.state.memoryAgentId && ctx.agents.some(a => a.id === ctx.state.memoryAgentId) ? ctx.state.memoryAgentId : ctx.agents[0].id;
    ctx.state.memoryAgentId = selected;
    let notes = [], current, dirty = false, saving = false, mode = ctx.state.memoryMode === 'preview' ? 'preview' : 'edit', spaceGeneration = 0, noteGeneration = 0;
    ctx.state.memoryNotes ??= {};
    const list = h('div', { class: 'note-list' }), editor = h('div', { class: 'note-editor' });
    const selector = select(ctx.agents.map(a => ({ value: a.id, label: (a.displayName ?? a.id) + ' · ' + actorName(ctx, a.ownerId) })), selected, async (event) => { const next = event.target.value; if (dirty) {
        selector.value = selected;
        confirm('切换记忆空间', '当前笔记有未保存内容，切换会放弃这些修改。', async () => { selected = next; selector.value = next; ctx.state.memoryAgentId = next; dirty = false; await loadNotes(); }, '放弃并切换');
    }
    else {
        selected = next;
        ctx.state.memoryAgentId = next;
        await loadNotes();
    } }, { 'aria-label': '记忆所属 Agent' });
    async function choose(noteId) { if (dirty) {
        confirm('读取另一篇笔记', '当前有未保存内容，继续会放弃这些修改。', async () => { dirty = false; await openNote(noteId); }, '放弃并读取');
        return;
    } await openNote(noteId); }
    function renderList() { list.replaceChildren(h('p', { class: 'note-list-title' }, 'PRIVATE MEMORY · ' + notes.length), ...notes.map(n => h('button', { class: 'note-button' + (current?.noteId === n.noteId ? ' active' : ''), onClick: () => notify(choose(n.noteId)) }, h('strong', {}, icon(n.noteId === 'INDEX' ? 'brain' : 'file', 15), n.noteId, h('span', { class: 'count-label' }, 'v' + n.version)), h('small', {}, n.excerpt.replace(/[#\n]/gu, ' '))))); if (!notes.length)
        list.append(h('p', { class: 'muted' }, '这个 Agent 还没有笔记。')); }
    async function loadNotes() { const requestVersion = ++spaceGeneration; const target = selected; ctx.state.memoryAgentId = target; ctx.persistState?.(); ++noteGeneration; editor.replaceChildren(h('div', { class: 'loading-state' }, h('span', { class: 'loader' }), '正在读取独立记忆…')); const result = await api('/v1/agents/' + encodeURIComponent(target) + '/memory'); if (requestVersion !== spaceGeneration || target !== selected || ctx.isCurrent?.() === false)
        return; notes = result; current = undefined; renderList(); if (notes.length)
        await openNote(notes.find(n => n.noteId === ctx.state.memoryNotes[target])?.noteId ?? notes.find(n => n.noteId === 'INDEX')?.noteId ?? notes[0].noteId);
    else
        editor.replaceChildren(empty('建立这个岗位的记忆', '先创建 INDEX 作为索引，再用 [[笔记编号]] 关联需要的内容。', button('新建 INDEX', () => createNote('INDEX'), 'primary'))); }
    async function openNote(noteId) { const requestVersion = ++noteGeneration; const target = selected; try {
        const result = await api('/v1/agents/' + encodeURIComponent(target) + '/memory/' + encodeURIComponent(noteId));
        if (requestVersion !== noteGeneration || target !== selected || ctx.isCurrent?.() === false)
            return;
        current = result;
        dirty = false;
        ctx.state.memoryAgentId = selected;
        ctx.state.memoryNotes[selected] = noteId;
        ctx.persistState?.();
        renderEditor();
        renderList();
    }
    catch (error) {
        if (requestVersion !== noteGeneration || target !== selected || ctx.isCurrent?.() === false)
            return;
        if (error.code === 'NOT_FOUND')
            createNote(noteId);
        else
            throw error;
    } }
    function createNote(initial = '') { const noteId = h('input', { value: initial, required: true, pattern: '[A-Za-z0-9][A-Za-z0-9_-]{0,79}', placeholder: '例如 INDEX、ROLE、reply-rules' }); const text = h('textarea', { value: initial ? '# ' + initial + '\n' : '', rows: 6, placeholder: '写入工作索引、职责或经验。' }); modal('新建记忆笔记', '笔记只属于当前 Agent，已有同名内容不会被覆盖。', h('div', {}, field('笔记编号', noteId, '字母、数字、短横线或下划线；创建后通过编号链接。'), field('笔记内容', text)), async () => { await api('/v1/agents/' + encodeURIComponent(selected) + '/memory/' + encodeURIComponent(noteId.value), 'PUT', { markdown: text.value, expectedVersion: 0, sourceRefs: [] }); toast('笔记已创建'); notes = await api('/v1/agents/' + encodeURIComponent(selected) + '/memory'); dirty = false; await openNote(noteId.value); }, { saveLabel: '创建笔记' }); }
    function renderEditor() {
        const editingAgentId = selected;
        const editingNote = current;
        const agent = ctx.agents.find(a => a.id === selected);
        const status = h('span', {}, '已保存');
        const text = h('textarea', { class: 'markdown-input', value: current.markdown, spellcheck: false, readOnly: !agent.active, 'aria-label': '记忆 Markdown 内容', onInput: () => { dirty = true; status.textContent = '有未保存修改'; save.disabled = false; } });
        const source = h('input', { value: current.sourceRefs.join(', '),readOnly:!agent.active, placeholder: '可选，以逗号分隔，例如 document:123', 'aria-label': '记忆来源引用', onInput: () => { dirty = true; status.textContent = '有未保存修改'; save.disabled = false; } });
        const error = h('div', { class: 'form-error editor-error', hidden: true, role: 'alert' });
        const workspace = h('div');
        const editButton = button('编辑', () => { mode = 'edit'; ctx.state.memoryMode = mode; ctx.persistState?.(); renderMode(); }, 'text');
        const previewButton = button('预览', () => { mode = 'preview'; ctx.state.memoryMode = mode; ctx.persistState?.(); renderMode(); }, 'text');
        const tabs = h('div', { class: 'tabs' }, editButton, previewButton);
        function renderMode() { editButton.className = mode === 'edit' ? 'active' : ''; previewButton.className = mode === 'preview' ? 'active' : ''; workspace.replaceChildren(mode === 'edit' ? text : markdown(text.value, id => notify(choose(id)))); }
        const save = button([icon('check', 14), '保存笔记'], async () => { saving = true; save.disabled = true;text.readOnly=true;source.readOnly=true;status.textContent='正在保存…'; error.hidden = true; try {
            const saved = await api('/v1/agents/' + encodeURIComponent(editingAgentId) + '/memory/' + encodeURIComponent(editingNote.noteId), 'PUT', { markdown: text.value, expectedVersion: editingNote.version, sourceRefs: source.value.split(',').map(s => s.trim()).filter(Boolean) });
            if (selected !== editingAgentId || current !== editingNote) {
                toast('笔记已保存到原记忆空间');
                return;
            }
            current = saved;
            dirty = false;
            const noteList = await api('/v1/agents/' + encodeURIComponent(editingAgentId) + '/memory');
            if (selected !== editingAgentId || current !== saved)
                return;
            notes = noteList;
            renderList();
            renderEditor();
            toast('已保存，当前版本 v' + current.version);
        }
        catch (e) {
            error.textContent = e.code === 'CONFLICT' ? '笔记已有新版本。当前草稿已保留，请核对后重新读取，再决定如何合并。' : e.message;
            error.hidden = false;
            save.disabled = false;status.textContent='保存未完成，草稿已保留';
        }finally{saving=false;text.readOnly=!agent.active;source.readOnly=!agent.active;} }, 'primary', { disabled: !agent.active });
        const reload = button([icon('refresh', 13), '重新读取'], () => { if (dirty)
            confirm('重新读取笔记', '将放弃当前修改，读取数据库中的最新版本。', async () => { dirty = false; await openNote(current.noteId); }, '重新读取');
        else
            notify(openNote(current.noteId)); }, 'secondary');
        editor.replaceChildren(h('div', { class: 'editor-heading' }, h('div', {}, h('h2', {}, current.noteId), h('div', { class: 'editor-meta' }, badge('v' + current.version, 'primary'), h('span', {}, date(current.updatedAt)), h('span', {}, '仅此 Agent'))), tabs), ...(!agent.active ? [h('div', { class: 'notice warning space-bottom' }, 'Agent 已停用，可读取历史记忆。')] : []), error, workspace, h('div', { class: 'editor-footer' }, status, h('span', {}, current.markdown.length + ' 字符 · 按版本保存')), h('div', { class: 'source-field' }, field('来源引用', source, '只记录必要的来源标识，不把全部文档放入每次上下文。')), h('div', { class: 'button-row' }, save, reload));
        renderMode();
    }
    async function refreshNotes() {
        if (dirty || saving) return false;
        const target = selected, space = spaceGeneration, selection = noteGeneration, prior = current;
        const valid = () => !dirty && !saving && target === selected && space === spaceGeneration && selection === noteGeneration && current === prior && ctx.isCurrent?.() !== false;
        const result = await api('/v1/agents/' + encodeURIComponent(target) + '/memory');
        if (!valid()) return false;
        if (JSON.stringify(result) !== JSON.stringify(notes)) { notes = result; renderList(); }
        if (!prior) { if (notes.length) await openNote(notes.find(n => n.noteId === ctx.state.memoryNotes[target])?.noteId ?? notes[0].noteId); return; }
        const latest = notes.find(n => n.noteId === prior.noteId);
        if (!latest || latest.version === prior.version) return;
        const updated = await api('/v1/agents/' + encodeURIComponent(target) + '/memory/' + encodeURIComponent(prior.noteId));
        // Typing, saving or selecting another note while the request was in
        // flight must not replace the editor with its late response.
        if (!valid()) return false;
        current = updated; renderList(); renderEditor();
    }
    await loadNotes();
    const live = liveRefresh(ctx, refreshNotes, () => saving ? '正在保存笔记' : dirty ? '草稿未保存' : '');
    return h('div', {}, heading('独立记忆', '先读索引，再按需读取笔记；工作日志不自动塞入上下文。', button([icon('plus', 15), '新建笔记'], () => createNote(), 'primary')), h('section', { class: 'panel' }, h('div', { class: 'toolbar' }, h('div', { class: 'toolbar-left' }, icon('brain'), selector), live), h('div', { class: 'memory-layout' }, list, editor)));
}
export async function logsView(ctx) {
    const filters = ctx.state.logs ??= {};
    let currentAgent = ctx.agents.some(a => a.id === filters.agentId) ? filters.agentId : '', q = filters.q ?? '', type = events[filters.type] ? filters.type : '', before = filters.before || undefined, generation = 0, fingerprint;
    let draftQ = q;
    const remember = () => { Object.assign(filters, { agentId: currentAgent, q, type, before: before ?? null }); ctx.persistState?.(); };
    const content = h('div');
    let response;
    const search = searchInput('搜索事件、员工或运行编号', event => draftQ = event.target.value);
    search.querySelector('input').value = q;
    const query = () => { q = draftQ; before = undefined; remember(); return load(); };
    search.querySelector('input').addEventListener('keydown', e => { if (e.key === 'Enter')
        notify(query()); });
    const agentSelect = select([{ value: '', label: '全部 Agent' }, ...ctx.agents.map(a => ({ value: a.id, label: a.displayName ?? a.id }))], currentAgent, e => { currentAgent = e.target.value; notify(query()); }, { 'aria-label': '日志 Agent 筛选' });
    const typeSelect = select([{ value: '', label: '全部事件' }, ...Object.entries(events).map(([value, label]) => ({ value, label }))], type, e => { type = e.target.value; notify(query()); }, { 'aria-label': '日志事件筛选' });
    async function load() { const requestVersion = ++generation; const params = new URLSearchParams(); if (currentAgent)
        params.set('agentId', currentAgent); if (q)
        params.set('q', q); if (type)
        params.set('type', type); if (before)
        params.set('before', before); const result = await api('/v1/admin/activity?' + params); if (requestVersion !== generation || ctx.isCurrent?.() === false)
        return false; response = result; const signature = JSON.stringify(result); if (signature === fingerprint) return; fingerprint = signature;
        content.replaceChildren(table([{ label: '时间', render: r => h('span', { class: 'log-time' }, date(r.createdAt)) }, { label: '事件', render: r => eventCell(r.type) }, { label: 'Agent', render: r => r.data.agentId ? nameCell(agentName(ctx, r.data.agentId), r.data.agentId, 'teal') : h('span', { class: 'muted' }, '平台操作') }, { label: '操作员工', render: r => r.data.principalId ? actorName(ctx, r.data.principalId) : '—' }, { label: '详情', render: r => button('查看', () => details(events[r.type] ?? '运行日志', r), 'text') }], response.items, { empty: '没有符合条件的日志。' }), h('div', { class: 'table-footer' }, h('span', {}, '本页 ' + response.items.length + ' 条 · 最新记录在前'), h('div', { class: 'button-row' }, button('回到最新', () => notify(query()), 'text'), button('更早记录', () => { before = response.nextCursor; remember(); notify(load()); }, 'secondary small', { disabled: !response.nextCursor })))); }
    await load();
    remember();
    const live = liveRefresh(ctx, load, () => before ? '正在查看历史记录' : draftQ !== q ? '搜索条件尚未应用' : '');
    return h('div', {}, heading('日志与工作记录', '每次执行、权限检查、记忆修改和管理操作都有可追踪记录。', live), h('section', { class: 'panel' }, h('div', { class: 'toolbar' }, h('div', { class: 'toolbar-left' }, search, agentSelect, typeSelect), button([icon('search', 14), '查询'], () => notify(query()))), content));
}
export async function usageView(ctx) {
    const filters = ctx.state.usage ??= {};
    let days = ['7', '30', '90'].includes(filters.days) ? filters.days : '7', agentId = ctx.agents.some(a => a.id === filters.agentId) ? filters.agentId : '', principalId = ctx.employees.some(e => e.id === filters.principalId) ? filters.principalId : '', generation = 0, fingerprint;
    const remember = () => { Object.assign(filters, { days, agentId, principalId }); ctx.persistState?.(); };
    const body = h('div');
    const range = select([{ value: '7', label: '最近 7 日' }, { value: '30', label: '最近 30 日' }, { value: '90', label: '最近 90 日' }], days, e => { days = e.target.value; remember(); notify(load()); }, { 'aria-label': '用量时间范围' });
    const agentFilter = select([{ value: '', label: '全部 Agent' }, ...ctx.agents.map(a => ({ value: a.id, label: a.displayName ?? a.id }))], agentId, e => { agentId = e.target.value; remember(); notify(load()); }, { 'aria-label': '用量 Agent 筛选' });
    const personFilter = select([{ value: '', label: '全部员工' }, ...ctx.employees.map(e => ({ value: e.id, label: e.displayName ?? e.id }))], principalId, e => { principalId = e.target.value; remember(); notify(load()); }, { 'aria-label': '用量员工筛选' });
    async function load() {
        const requestVersion = ++generation;
        const params = new URLSearchParams({ days });
        if (agentId)
            params.set('agentId', agentId);
        if (principalId)
            params.set('principalId', principalId);
        const usage = await api('/v1/admin/usage?' + params);
        if (requestVersion !== generation || ctx.isCurrent?.() === false)
            return false;
        const signature = JSON.stringify(usage);
        if (signature === fingerprint) return;
        fingerprint = signature;
        const total = usage.totals;
        const ranks = h('div', { class: 'usage-ranking' }, usage.byEmployee.length ? usage.byEmployee.map(e => h('div', { class: 'ranking-row' }, nameCell(actorName(ctx, e.principalId), e.principalId), h('div', {}, h('strong', {}, number(e.inputTokens + e.outputTokens)), h('p', { class: 'field-hint' }, e.requests + ' 次请求')))) : empty('暂无模型用量', '工具验证不消耗模型 tokens。'));
        body.replaceChildren(h('div', { class: 'metrics' }, metric('模型请求', total.requests, '按实际请求逐条记账', 'activity'), metric('输入 Tokens', total.inputTokens, '含服务商记录的输入用量', 'chart'), metric('输出 Tokens', total.outputTokens, '按本次调用实际输出记录', 'bot'), metric('待核对请求', total.unmeasuredRequests, '另有 ' + total.reportedRequests + ' 条远程上报', 'shield')), h('div', { class: 'usage-grid' }, panel('Token 使用趋势', '最近 ' + usage.days + ' 日 · 上海时区', chart(usage.series)), panel('员工用量分布', '按执行员工归属，保留任务发起者', ranks)), h('div', { class: 'notice space-bottom' }, icon('shield'), h('span', {}, '当前展示 Token 用量，金额费率尚未配置。服务商实测、远程上报与缺失用量会分别标记，不将缺失费用记为零。')), panel('最近模型请求', '最多展示 100 条，汇总统计包含当前筛选范围全部请求。', table([{ label: '时间', render: r => h('span', { class: 'log-time' }, date(r.createdAt)) }, { label: '员工 / Agent', render: r => nameCell(actorName(ctx, r.data.principalId), agentName(ctx, r.data.agentId)) }, { label: '模型', render: r => h('span', { class: 'mono' }, r.data.model ?? r.data.provider ?? '—') }, { label: '输入 / 输出', render: r => h('span', { class: 'mono' }, r.data.inputTokens === null ? '待核对' : number(r.data.inputTokens) + ' / ' + number(r.data.outputTokens)) }, { label: '计量来源', render: r => badge(r.data.measurement === 'provider' ? '服务商实测' : r.data.measurement === 'remote-reported' ? '远程上报' : '待核对', r.data.measurement === 'provider' ? 'success' : 'warning') }, { label: '详情', render: r => button('查看', () => details('模型请求记录', r), 'text') }], usage.records, { empty: '当前筛选范围没有模型请求。' })));
    }
    await load();
    remember();
    return h('div', {}, heading('模型用量', '公司集中持有模型凭证，每次调用仍能追踪到员工与岗位。', liveRefresh(ctx, load)), h('div', { class: 'section-toolbar' }, h('div', { class: 'filters' }, range, agentFilter, personFilter)), body);
}
export const views = { overview: overviewView, employees: employeesView, agents: agentsView, plugins: pluginsView, memory: memoryView, logs: logsView, usage: usageView, organization: organizationView, work: workView, assistant: assistantView, channels: channelsView,entries:async ctx=>(await import('./entry-view.js')).entryView(ctx) };
