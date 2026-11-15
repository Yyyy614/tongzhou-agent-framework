import { api, parseJson, idempotency,ApiError } from './api.js';
import { h, icon, button, field, select, checklist, checked, modal, confirm, toast, details, badge } from './ui.js';
const services = [{value:'connection.catalog.read',label:'查看授权接口目录'}, { value: 'memory.self.read', label: '读取自己的记忆' }, { value: 'memory.self.propose_write', label: '更新自己的记忆' }, { value: 'report.self.write', label: '记录工作报告' }, { value: 'team.read', label: '查看团队摘要' }, { value: 'team.dispatch', label: '向下级派工' }, { value: 'team.review', label: '核对下级工作' }, { value: 'work.read', label: '插件查询协作工作' }, { value: 'work.dispatch', label: '插件发起协作工作' }, { value: 'reminder.write', label: '设置工作提醒' }, { value: 'reminder.read', label: '插件查询提醒' }, { value: 'inbox.self.read', label: '查看本人通知' }, { value: 'event.self.publish', label: '提交问题事件' }];
export const employeeBody = actor => Object.fromEntries(['id', 'displayName', 'department', 'departmentId', 'managerId', 'teamScope', 'role', 'permissions', 'active', 'revision'].filter(k => actor[k] !== undefined).map(k => [k, actor[k]]));
export const agentBody = agent => Object.fromEntries(['preset', 'id', 'displayName', 'ownerId', 'pluginId', 'pluginVersion', 'config', 'plugins', 'allowedTools', 'servicePermissions', 'instructions', 'runtime', 'connectionRef', 'delegates', 'active', 'revision'].filter(k => agent[k] !== undefined).map(k => [k, agent[k]]));
const mounted = agent => [{ pluginId: agent.pluginId, pluginVersion: agent.pluginVersion, config: agent.config }, ...(agent.plugins ?? [])];
const allTools = plugins => [...new Map(plugins.flatMap(p => p.tools.map(t => [t.ref, { value: t.ref, label: t.id, hint: p.id }]))).values()];
const section = label => h('h3', { class: 'section-label' }, label);
export function editEmployee(ctx, actor) {
    const create = !actor;
    actor ??= { id: 'employee-' + Date.now().toString(36), role: 'employee', permissions: ['memory.self.read', 'memory.self.propose_write', 'report.self.write', 'inbox.self.read', 'reminder.read', 'reminder.write', 'event.self.publish', 'work.read'], active: true };
    const name = h('input', { value: actor.displayName ?? '', required: true, maxLength: 80, placeholder: '例如：张明' });
    const id = h('input', { value: actor.id, required: true, readOnly: !create, pattern: '[A-Za-z0-9][A-Za-z0-9_-]{0,63}' });
    const department = h('input', { value: actor.department ?? '', maxLength: 80, placeholder: '填写所属部门' });
    const departmentId = select([{ value: '', label: '未分配部门' }, ...(ctx.departments ?? []).map(d => ({ value: d.id, label: d.name, disabled: !d.active }))], actor.departmentId ?? '');
    const manager = select([{ value: '', label: '无直属上级' }, ...ctx.employees.filter(e => e.id !== actor.id).map(e => ({ value: e.id, label: e.displayName ?? e.id, disabled: !e.active }))], actor.managerId ?? '');
    const teamScope = select([{ value: 'none', label: '仅本人' }, { value: 'direct', label: '直属下级' }, { value: 'subtree', label: '全部下级' }], actor.teamScope ?? 'none');
    const role = select([{ value: 'employee', label: '员工' }, { value: 'admin', label: '管理员' }], actor.role);
    const active = h('input', { type: 'checkbox', checked: actor.active });
    const toolOptions = allTools(ctx.plugins).map(t => ({ ...t, value: 'tool.invoke:' + t.value }));
    const tools = checklist(toolOptions, actor.permissions);
    const ownServices = checklist(services, actor.permissions);
    const scopes = checklist(ctx.agents.flatMap(a => [{ value: 'agent.read:' + a.id, label: '查看工作 · ' + (a.displayName ?? a.id), hint: '可看日志和结果，不包含私有记忆' }, { value: 'agent.execute:' + a.id, label: '派工 · ' + (a.displayName ?? a.id), hint: '允许向该岗位分配任务' }]), actor.permissions);
    const known = new Set([...toolOptions.map(t => t.value), ...allTools(ctx.plugins).map(t => t.value), ...services.map(s => s.value), ...ctx.agents.flatMap(a => ['agent.read:' + a.id, 'agent.execute:' + a.id])]);
    const preserved = actor.permissions.filter(p => !known.has(p));
    const body = h('div', {}, h('div', { class: 'form-grid' }, field('员工姓名', name), field('员工编号', id, '创建后固定，用于绑定身份。'), field('所属部门', department), field('账号角色', role)), h('label', { class: 'check-row' }, active, h('span', {}, '启用此员工账号')), section('个人记忆与报告'), ownServices, section('可使用的插件工具'), tools, h('details', { class: 'advanced' }, h('summary', {}, '其他岗位的查看与派工权限'), scopes), h('div', { class: 'notice space-top' }, icon('shield'), h('span', {}, '工具需要同时获得员工授权和 Agent 授权。管理员仍受岗位范围、公司范围与写操作审批约束。')));
    modal(create ? '新增员工' : '编辑员工', '管理平台身份、所属部门与明确的能力授权。', body, async () => {
        const payload = { id: id.value, displayName: name.value.trim(), department: department.value.trim(), departmentId: departmentId.value || null, managerId: manager.value || null, teamScope: teamScope.value, role: role.value, permissions: [...new Set([...checked(tools), ...checked(ownServices), ...checked(scopes), ...preserved])], active: active.checked, ...(!create ? { revision: actor.revision } : {}) };
        await api('/v1/admin/employees' + (create ? '' : '/' + encodeURIComponent(actor.id)), create ? 'POST' : 'PUT', payload);
        toast(create ? '员工已创建' : '员工信息与权限已保存');
        await ctx.refresh();
    }, { wide: true, saveLabel: create ? '创建员工' : '保存修改' });
    body.prepend(h('div', { class: 'form-grid' }, field('组织部门', departmentId), field('直属上级', manager), field('管理范围', teamScope, '还需勾选团队查看、派工、核对权限；不会开放下级私人记忆。')));
}
export function toggleEmployee(ctx, actor) { confirm(actor.active ? '停用员工账号' : '重新启用员工', actor.active ? '停用后，该员工不能继续登录或发起新的 Agent 操作，已有记录会保留。' : '将恢复该员工的登录与已授予能力。', async () => { await api('/v1/admin/employees/' + encodeURIComponent(actor.id), 'PUT', { ...employeeBody(actor), displayName: actor.displayName ?? actor.id, active: !actor.active }); toast(actor.active ? '员工已停用' : '员工已启用'); await ctx.refresh(); }, actor.active ? '确认停用' : '确认启用'); }
export function editAgent(ctx, agent) {
    if (agent && mounted(agent).some(b => !ctx.plugins.find(p => p.id === b.pluginId && p.version === b.pluginVersion)?.enabled)) {
        toast('请先启用这个 Agent 已绑定的插件版本，再修改配置。', 'danger');
        return;
    }
    const create = !agent;
    const enabled = ctx.plugins.filter(p => p.enabled);
    if (!enabled.length) {
        toast('请先安装并启用一个插件包。', 'danger');
        return;
    }
    agent ??= { id: 'agent-' + Date.now().toString(36), ownerId: ctx.employees.find(e => e.active && e.role === 'employee')?.id ?? ctx.me.id, pluginId: enabled[0].id, pluginVersion: enabled[0].version, config: {}, plugins: [], allowedTools: [], servicePermissions: [], active: true, runtime: 'harness' };
    const name = h('input', { value: agent.displayName ?? '', required: true, maxLength: 80, placeholder: '例如：岗位工作助手' });
    const id = h('input', { value: agent.id, required: true, readOnly: !create, pattern: '[A-Za-z0-9][A-Za-z0-9_-]{0,63}' });
    const owner = select(ctx.employees.map(e => ({ value: e.id, label: (e.displayName ?? e.id) + (e.department ? ' · ' + e.department : ''), disabled: !e.active })), agent.ownerId, undefined, { disabled: !create });
    const preset = select([{ value: '', label: '自定义工作方式' }, ...(ctx.presets ?? []).map(p => ({ value: p.id + '@' + p.version, label: p.name + ' · ' + p.version }))], agent.preset ? agent.preset.id + '@' + agent.preset.version : '');
    const runtime = select([{ value: 'harness', label: 'DeepSeek Harness' }, { value: 'remote', label: '已配置的远程 Agent' }], agent.runtime ?? 'harness');
    const connection = h('input', { value: agent.connectionRef ?? '', placeholder: 'connection:your-agent', disabled: runtime.value !== 'remote' });
    runtime.addEventListener('change', () => connection.disabled = runtime.value !== 'remote');
    const primary = select(enabled.map(p => ({ value: p.id + '@' + p.version, label: p.id + ' · ' + p.version })), agent.pluginId + '@' + agent.pluginVersion);
    const config = h('textarea', { class: 'json-input', value: JSON.stringify(agent.config ?? {}, null, 2), spellcheck: false });
    const instructions = h('textarea', { value: agent.instructions ?? '', maxLength: 8000, placeholder: '描述这个岗位的职责、工作边界和回复要求。', rows: 4 });
    const active = h('input', { type: 'checkbox', checked: agent.active });
    const reason = h('input', { value: create ? '创建岗位' : '更新岗位配置', required: true, maxLength: 1000 });
    const toolBox = h('div');
    const serviceBox = h('div');
    let toolChecks, serviceChecks;
    function renderCapabilities() { const p = enabled.find(p => p.id + '@' + p.version === primary.value); const extras = (agent.plugins ?? []).map(b => ctx.plugins.find(p => p.id === b.pluginId && p.version === b.pluginVersion)).filter(Boolean); const packages = [p, ...extras].filter(Boolean); const selectedTools = toolChecks ? checked(toolChecks) : agent.allowedTools; const selectedServices = serviceChecks ? checked(serviceChecks) : agent.servicePermissions ?? []; toolChecks = checklist(allTools(packages), selectedTools); serviceChecks = checklist(services.filter(s => packages.some(p => p.permissions.includes(s.value))), selectedServices); toolBox.replaceChildren(toolChecks); serviceBox.replaceChildren(serviceChecks); }
    primary.addEventListener('change', () => { config.value = '{}'; renderCapabilities(); });
    renderCapabilities();
    const delegates = checklist(ctx.agents.filter(a => a.id !== agent.id).map(a => ({ value: a.id, label: a.displayName ?? a.id, hint: '负责人还需要拥有该岗位的派工权限' })), agent.delegates ?? []);
    const body = h('div', {}, h('div', { class: 'form-grid' }, field('Agent 名称', name), field('Agent 编号', id), field('负责人', owner, create ? '执行时沿用负责人员工的能力授权。' : '负责人固定；人员交接请新建 Agent，避免私有记忆被意外转移。'), field('运行方式', runtime)), field('岗位预设', preset, '选择工作范式；不会自动授予工具、人员或数据访问权限。'), field('远程连接引用', connection), section('岗位职责'), field('工作指令', instructions), section('基础插件'), field('插件与精确版本', primary), field('插件配置（JSON）', config, '密钥通过服务端连接管理，此处只填写插件业务配置。'), section('允许这个 Agent 使用的工具'), toolBox, section('记忆与报告能力'), serviceBox, h('details', { class: 'advanced' }, h('summary', {}, '协调岗位：允许派工的目标'), delegates, h('p', { class: 'field-hint' }, '协作工作最多并行分配8个岗位；旧版直接子任务仍最多2个。只接收工作结果和引用。')), h('label', { class: 'check-row' }, active, h('span', {}, '启用此 Agent')), field('变更说明', reason), h('div', { class: 'notice' }, icon('brain'), h('span', {}, '每个 Agent 有独立记忆。修改挂载需要等待活动任务结束，其他岗位配置不受影响。')));
    modal(create ? '创建 Agent' : '配置 Agent', create ? '创建可绑定员工、能力和独立记忆的岗位。' : '修改真实岗位配置；当前页面保留版本检查。', body, async () => {
        const p = enabled.find(p => p.id + '@' + p.version === primary.value);
        const additional = (agent.plugins ?? []).filter(b => b.pluginId !== p.id);
        const payload = { ...agentBody(agent), id: id.value, displayName: name.value.trim(), ownerId: owner.value, pluginId: p.id, pluginVersion: p.version, config: parseJson(config.value), plugins: additional, allowedTools: checked(toolChecks), servicePermissions: checked(serviceChecks), instructions: instructions.value, runtime: runtime.value, delegates: checked(delegates), active: active.checked, reason: reason.value.trim() };
        if (preset.value) { const chosen = ctx.presets.find(p => p.id + '@' + p.version === preset.value); payload.preset = { id: chosen.id, version: chosen.version }; } else delete payload.preset;
        if (runtime.value === 'remote')
            payload.connectionRef = connection.value.trim();
        else
            delete payload.connectionRef;
        await api('/v1/admin/agents' + (create ? '' : '/' + encodeURIComponent(agent.id)), create ? 'POST' : 'PUT', payload);
        toast(create ? 'Agent 已创建，可为它添加独立记忆' : 'Agent 配置已保存');
        await ctx.refresh();
    }, { wide: true, saveLabel: create ? '创建 Agent' : '保存配置' });
}
export function toggleAgent(ctx, agent) { confirm(agent.active ? '停用 Agent' : '重新启用 Agent', agent.active ? '停用后会拦截后续工具与记忆写入，历史记录保留。已完成的外部动作不会被撤销。' : '恢复岗位执行前，会检查负责人和插件是否可用。', async () => { await api('/v1/admin/agents/' + encodeURIComponent(agent.id) + '/state', 'POST', { active: !agent.active, revision: agent.revision }); toast(agent.active ? 'Agent 已停用' : 'Agent 已启用'); await ctx.refresh(); }, agent.active ? '确认停用' : '确认启用'); }
export function mountPlugin(ctx, plugin, preselected) {
    if (!ctx.agents.length) {
        toast('请先创建一个 Agent，再挂载额外插件。', 'danger');
        return;
    }
    const target = select(ctx.agents.map(a => ({ value: a.id, label: a.displayName ?? a.id })), preselected ?? ctx.agents[0].id);
    const config = h('textarea', { class: 'json-input', value: '{}', spellcheck: false });
    let tools;
    const box = h('div');
    const reason = h('input', { value: '调整插件挂载', required: true, maxLength: 1000 });
    function update() { const a = ctx.agents.find(a => a.id === target.value); const binding = mounted(a).find(b => b.pluginId === plugin.id); config.value = JSON.stringify(binding?.config ?? {}, null, 2); tools = checklist(plugin.tools.map(t => ({ value: t.ref, label: t.id, hint: t.effect === 'write' ? '写操作 · 需要精确审批' : '读取操作' })), binding ? a.allowedTools : plugin.tools.map(t => t.ref)); box.replaceChildren(tools); }
    target.addEventListener('change', update);
    update();
    const body = h('div', {}, field('目标 Agent', target), h('div', { class: 'notice space-bottom' }, icon('box'), h('span', {}, plugin.id + ' · ' + plugin.version + '，将精确绑定此版本。')), field('插件配置（JSON）', config), section('允许岗位调用的工具'), box, field('变更说明', reason), h('p', { class: 'field-hint' }, '挂载不会自动扩大员工权限；如工具不可用，请在员工管理中给负责人授予对应能力。'));
    modal('挂载插件', '只修改选中的 Agent，其他岗位保持原有版本。', body, async () => {
        const agent = ctx.agents.find(a => a.id === target.value);
        const payload = { ...agentBody(agent), reason: reason.value.trim() };
        const entry = { pluginId: plugin.id, pluginVersion: plugin.version, config: parseJson(config.value) };
        if (agent.pluginId === plugin.id) {
            payload.pluginVersion = plugin.version;
            payload.config = entry.config;
        }
        else
            payload.plugins = [...(agent.plugins ?? []).filter(b => b.pluginId !== plugin.id), entry];
        payload.allowedTools = [...agent.allowedTools.filter(t => !t.startsWith(plugin.id + ':')), ...checked(tools)];
        await api('/v1/admin/agents/' + encodeURIComponent(agent.id), 'PUT', payload);
        toast('插件已挂载到 ' + (agent.displayName ?? agent.id));
        await ctx.refresh();
    }, { wide: true, saveLabel: '确认挂载' });
}
export function unmountPlugin(ctx, agent, binding) {
    if (binding.pluginId === agent.pluginId) {
        toast('基础插件需要通过 Agent 配置替换，不能直接移除。', 'danger');
        return;
    }
    confirm('移除插件挂载', '只移除这个岗位的能力绑定，插件包与历史日志会保留。', async () => { const payload = { ...agentBody(agent), plugins: (agent.plugins ?? []).filter(b => b.pluginId !== binding.pluginId), allowedTools: agent.allowedTools.filter(t => !t.startsWith(binding.pluginId + ':')), reason: '移除额外插件挂载' }; const remaining = [{ pluginId: agent.pluginId, pluginVersion: agent.pluginVersion }, ...payload.plugins].map(b => ctx.plugins.find(p => p.id === b.pluginId && p.version === b.pluginVersion)); payload.servicePermissions = (agent.servicePermissions ?? []).filter(p => remaining.some(b => b?.permissions.includes(p))); await api('/v1/admin/agents/' + encodeURIComponent(agent.id), 'PUT', payload); toast('挂载已移除'); await ctx.refresh(); }, '移除挂载');
}
export function showBindings(ctx, agent) { modal('插件挂载 · ' + (agent.displayName ?? agent.id), '每个能力包独立配置并固定版本。', h('div', {}, mounted(agent).map((binding, i) => h('div', { class: 'ranking-row' }, h('div', {}, h('strong', { class: 'mono' }, binding.pluginId), h('p', { class: 'field-hint' }, binding.pluginVersion + ' · ' + (i === 0 ? '基础插件' : '附加插件'))), h('div', { class: 'button-row' }, button('配置', () => { document.querySelector('dialog')?.close(); const p = ctx.plugins.find(p => p.id === binding.pluginId && p.version === binding.pluginVersion); if (p)
    mountPlugin(ctx, p, agent.id); }, 'text'), i ? button('移除', () => { document.querySelector('dialog')?.close(); unmountPlugin(ctx, agent, binding); }, 'text') : badge('基础', 'primary'))))), null, { wide: true }); }
export function installPlugin(ctx) { const path = h('input', { required: true, placeholder: '插件包目录，例如 D:\\项目\\my-plugin' }); modal('安装插件包', '安装已审查的本机插件目录，校验格式、依赖和版本摘要。', field('插件包目录', path, '目录内需要包含 agent-plugin.json 和声明的文件。'), async () => { const result = await api('/v1/plugins/install', 'POST', { path: path.value.trim() }); toast(result.id + ' ' + result.version + ' 已安装'); await ctx.refresh(); }, { saveLabel: '校验并安装' }); }
export function validatePlugin(plugin) { const config = h('textarea', { class: 'json-input', value: '{}', spellcheck: false }); modal('验证插件', '使用所填配置执行初始化和健康检查。', field('验证配置（JSON）', config), async () => { await api('/v1/admin/plugins/validate', 'POST', { pluginId: plugin.id, version: plugin.version, config: parseJson(config.value) }); toast('插件初始化与健康检查通过'); }, { saveLabel: '运行验证' }); }
export function togglePlugin(ctx, plugin) { confirm(plugin.enabled ? '停用插件版本' : '启用插件版本', plugin.enabled ? '停用后，引用此版本的岗位将无法继续调用它。其他版本和历史记录保留。' : '启用此精确版本，已有岗位授权范围不会扩大。', async () => { await api('/v1/admin/plugins/state', 'POST', { pluginId: plugin.id, version: plugin.version, enabled: !plugin.enabled }); toast(plugin.enabled ? '插件版本已停用' : '插件版本已启用'); await ctx.refresh(); }, plugin.enabled ? '停用此版本' : '启用此版本'); }
function sample(schema) { if (schema.default !== undefined)
    return schema.default; if (schema.enum)
    return schema.enum[0]; if (schema.type === 'object')
    return Object.fromEntries((schema.required ?? []).map(k => [k, sample(schema.properties?.[k] ?? {})])); if (schema.type === 'array')
    return []; if (schema.type === 'integer' || schema.type === 'number')
    return 0; if (schema.type === 'boolean')
    return false; return '  验证   框架  '; }
export function runDialog(ctx, initial) {
    const intentKeys=new Map();const keyFor=intent=>{const signature=JSON.stringify(intent);if(!intentKeys.has(signature))intentKeys.set(signature,idempotency());return intentKeys.get(signature);};
    const available = ctx.agents.filter(a => a.active);
    if (!available.length) {
        toast('请先创建并启用一个 Agent。', 'danger');
        return;
    }
    const target = select(available.map(a => ({ value: a.id, label: a.displayName ?? a.id })), initial ?? available[0].id);
    const mode = select([{ value: 'tool', label: '插件工具验证 · 不调用模型' }, { value: 'task', label: 'Agent 任务 · 调用已配置模型' }], 'tool');
    const tool = select([], undefined);
    const input = h('textarea', { class: 'json-input', spellcheck: false });
    const prompt = h('textarea', { placeholder: '描述希望这个 Agent 完成的任务。', maxLength: 8000, rows: 4 });
    const accepted = h('input', { type: 'checkbox' });
    const toolSection = h('div', {}, field('插件工具', tool), field('工具输入（JSON）', input));
    const taskSection = h('div', { hidden: true }, field('任务内容', prompt), h('label', { class: 'check-row' }, accepted, h('span', {}, '确认调用模型，并将用量计入岗位负责人。')));
    let choices = [];
    function update() { const agent = available.find(a => a.id === target.value); choices = mounted(agent).flatMap(b => ctx.plugins.find(p => p.id === b.pluginId && p.version === b.pluginVersion)?.tools ?? []).filter(t => agent.allowedTools.includes(t.ref)); tool.replaceChildren(...choices.map(t => h('option', { value: t.ref }, t.id))); input.value = JSON.stringify(sample(choices[0]?.inputSchema ?? { type: 'object' }), null, 2); }
    target.addEventListener('change', update);
    tool.addEventListener('change', () => input.value = JSON.stringify(sample(choices.find(t => t.ref === tool.value)?.inputSchema ?? {}), null, 2));
    mode.addEventListener('change', () => { toolSection.hidden = mode.value !== 'tool'; taskSection.hidden = mode.value !== 'task'; });
    update();
    modal('运行验证', '工具验证按岗位负责人的真实授权执行，结果与日志直接保存到内核。', h('div', {}, field('选择 Agent', target), field('验证方式', mode), toolSection, taskSection), async () => {
        if (mode.value === 'tool') {
            if (!tool.value)
                throw new Error('这个 Agent 尚未允许任何插件工具，请先配置挂载。');
            const toolInput=parseJson(input.value,'工具输入');const intent={agentId:target.value,toolRef:tool.value,input:toolInput};
            const result = await api('/v1/admin/agents/' + encodeURIComponent(target.value) + '/try', 'POST', { toolRef: tool.value, input:toolInput, idempotencyKey:keyFor(intent) });
            if(result.outcome!=='succeeded'||!result.invocationId)throw new ApiError('RESULT_UNKNOWN','执行回执不完整，请核对原操作。',200);
            details('工具执行成功', { 结果: result.output, 执行编号: result.invocationId, 日志引用: result.evidenceRefs });
            toast('插件已通过真实内核执行');
        }
        else {
            if (!accepted.checked)
                throw new Error('请先确认模型调用和用量记录。');
            if (!prompt.value.trim())
                throw new Error('请填写任务内容。');
            const intent={agentId:target.value,prompt:prompt.value.trim()};let task = await api('/v1/tasks', 'POST', {...intent,idempotencyKey:keyFor(intent)});
            if(!task.id||typeof task.state!=='string')throw new ApiError('RESULT_UNKNOWN','任务回执不完整，请核对原提交。',200);
            for (let i = 0; i < 45 && ['queued', 'running'].includes(task.state); i++) {
                await new Promise(r => setTimeout(r, 1000));
                task = await api('/v1/tasks/' + task.id);
            }
            details('Agent 任务状态', task);
            toast(task.state === 'succeeded' ? 'Agent 任务已完成' : '任务已登记，可继续查看日志');
        }
        await ctx.refresh();
    }, { wide: true, saveLabel: '开始验证' });
}
