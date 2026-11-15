import { api, idempotency } from './api.js';
import { h, button, field, select, checklist, checked, modal, toast, details, heading, panel, table, badge, date, liveRefresh } from './ui.js';
import { editEmployee } from './editors.js';
import { resultView, readableText } from './result-view.mjs';
import {structuredResultView} from './structured-result.js';
const employeeName = (ctx, id) => ctx.employees.find(e => e.id === id)?.displayName ?? id ?? '—';
const agentName = (ctx, id) => ctx.agents.find(a => a.id === id)?.displayName ?? id;
const states = { queued: '排队中', running: '执行中', waiting_review: '等待人工核对', needs_attention: '需要处理', completed: '已核对完成', changes_requested: '核对未通过', pending: '等待处理', delivered: '已送达收件箱', cancelled: '已取消', processed: '已处理', failed: '失败', succeeded: '成功', reconciliation_required: '结果待核实', waiting_approval: '等待写操作审批' };
Object.assign(states,{stop_requested:'正在停止，等待收尾',stopped:'已停止',waiting:'等待人工或依赖',active:'可执行',unknown:'结果未知',not_executed:'确认未执行'});
const state = value => badge(states[value] ?? value, ['completed', 'succeeded', 'delivered'].includes(value) ? 'green' : ['needs_attention', 'failed', 'reconciliation_required'].includes(value) ? 'red' : 'purple');
const agentOptions = ctx => ctx.agents.filter(a => a.active && ctx.employees.some(e => e.id === a.ownerId && e.active)).map(a => ({ value: a.id, label: agentName(ctx, a.id) + ' · ' + employeeName(ctx, a.ownerId) }));
export async function organizationView(ctx) {
    const editDepartment = department => {
        const create = !department;
        department ??= { id: 'department-' + Date.now().toString(36), name: '', parentId: null, active: true };
        const id = h('input', { value: department.id, required: true, readOnly: !create, pattern: '[A-Za-z0-9][A-Za-z0-9_-]{0,63}' });
        const name = h('input', { value: department.name, required: true, maxLength: 80 });
        const parent = select([{ value: '', label: '顶层部门' }, ...ctx.departments.filter(d => d.id !== department.id).map(d => ({ value: d.id, label: d.name, disabled: !d.active }))], department.parentId ?? '');
        const active = h('input', { type: 'checkbox', checked: department.active });
        modal(create ? '新增部门' : '编辑部门', '部门树与人员汇报关系分别配置，循环关系由内核拒绝。', h('div', {}, field('部门编号', id), field('部门名称', name), field('上级部门', parent), field('启用部门', active)), async () => {
            await api('/v1/admin/departments' + (create ? '' : '/' + department.id), create ? 'POST' : 'PUT', { id: id.value, name: name.value.trim(), parentId: parent.value || null, active: active.checked, ...(!create ? { revision: department.revision } : {}) });
            toast('部门已保存'); await ctx.refresh();
        });
    };
    return h('div', {}, heading('组织与权限', '按汇报关系限定团队范围；工具授权、管理能力和私人记忆分别校验。', button('新增部门', () => editDepartment(), 'primary')),
        panel('部门结构', '可按公司需要建立任意部门。', table([{ label: '部门', key: 'name' }, { label: '上级部门', render: d => ctx.departments.find(p => p.id === d.parentId)?.name ?? '顶层' }, { label: '状态', render: d => badge(d.active ? '启用' : '停用') }, { label: '配置', render: d => button('编辑部门', () => editDepartment(d), 'text') }], ctx.departments)),
        panel('人员汇报关系', '负责人使用普通员工身份，显式授予团队权限。', table([{ label: '员工', render: e => employeeName(ctx, e.id) }, { label: '组织部门', render: e => ctx.departments.find(d => d.id === e.departmentId)?.name ?? e.department ?? '—' }, { label: '直属上级', render: e => employeeName(ctx, e.managerId) }, { label: '管理范围', render: e => ({ none: '仅本人', direct: '直属下级', subtree: '全部下级' })[e.teamScope ?? 'none'] }, { label: '团队权限', render: e => e.role === 'admin' ? '公司管理员' : e.permissions.filter(p => p.startsWith('team.')).join(' / ') || '未授权' }, { label: '配置', render: e => button('调整关系与权限', () => editEmployee(ctx, e), 'text') }], ctx.employees)));
}
export async function workView(ctx) {
    let rows = await api('/v1/work');
    const filter = select([{ value: '', label: '全部工作状态' }, ...['queued','running','waiting_review','needs_attention','completed','changes_requested','stop_requested','stopped','waiting','reconciliation_required'].map(value => ({ value, label: states[value] }))], ctx.state.workFilter ?? '', () => { ctx.state.workFilter = filter.value; render(); });
    const box = h('div');
    async function continueWork(row) {
        const current = await api('/v1/work/' + row.id);
        const target = select(current.assignments.map(a => ({ value: a.agentId, label: agentName(ctx, a.agentId) + ' · ' + employeeName(ctx, a.ownerId) })), current.assignments[0]?.agentId);
        const instruction = h('textarea', { required: true, rows: 5, maxLength: 8000, placeholder: '只填写本轮要补充或调整的内容。已确认的旧动作不会自动重做。' });
        const key = idempotency();
        modal('继续原工作', current.title + ' · 当前第' + current.currentRound + '轮', h('div', {}, field('执行岗位', target), field('本轮补充要求', instruction), h('p', { class: 'field-hint' }, '创建新一轮任务，保留旧结果与审核；本人旧结果可按需读取。执行中或结果待核实的工作暂不允许继续。')), async () => {
            if (!instruction.value.trim()) throw Error('请填写本轮补充要求。');
            await api('/v1/work/' + current.id + '/inputs', 'POST', { revision: current.revision, idempotencyKey: key, assignments: [{ agentId: target.value, prompt: instruction.value.trim() }] });
            toast('新一轮已受理'); await reload();
        }, { wide: true, saveLabel: '受理新一轮' });
    }
    async function history(row) {
        const record = await api('/v1/work/' + row.id + '/history');
        const content = h('div', {}, h('p', {}, row.title), record.rounds.map(round => h('section', {}, h('h3', {}, '第' + round.round + '轮'), table([{ label: '岗位', render: a => agentName(ctx, a.agentId) }, { label: '负责人', render: a => employeeName(ctx, a.ownerId) }, { label: '执行状态', render: a => state(a.state) }], round.assignments), record.reviews.filter(r => r.round === round.round).map(r => h('p', {}, (r.decision === 'approve' ? '核对通过：' : '要求调整：') + r.reason)))), h('details', {}, h('summary', {}, '技术记录'), h('pre', {}, JSON.stringify(record, null, 2))));
        modal('工作轮次与审核历史', '执行记录和旧审核保留；完整资料仍按权限单独读取。', content, null, { wide: true });
    }
    async function controlWork(row) {
        const current=await api('/v1/work/'+row.id),record=await api('/v1/work/'+row.id+'/control');
        const action=select([{value:'stop',label:'停止工作'},{value:'wait',label:'等待人工或依赖'},{value:'resume',label:'人工批准恢复'}],['stopped','waiting','needs_attention'].includes(current.state)?'resume':'stop');
        const reason=h('textarea',{rows:3,maxLength:1000,placeholder:'填写具体原因；恢复时说明已批准的决定。'});
        const question=h('textarea',{rows:2,maxLength:1000,placeholder:'等待时，填写需要谁决定什么。'});
        const target=select(current.assignments.map(a=>({value:a.agentId,label:agentName(ctx,a.agentId)+' · '+employeeName(ctx,a.ownerId)})),current.assignments[0]?.agentId);
        const prompt=h('textarea',{rows:4,maxLength:8000,placeholder:'恢复时只填写剩余要做的事；已确认相同动作会复用原回执。'});
        const key=idempotency();
        modal('工作控制',current.title,h('div',{},h('p',{},'当前：',state(current.state)),current.control?.question?h('p',{},'等待的问题：'+current.control.question):null,field('操作',action),field('原因 / 人工决定',reason),field('等待的问题（仅等待时）',question),field('恢复的执行岗位',target),field('恢复后的明确要求（仅恢复时）',prompt),h('p',{class:'field-hint'},'停止先关闭新动作准入，再等待已开始的动作收尾。结果未知时须先人工核实，不能直接恢复。恢复创建新轮次，保留旧记录。'),table([{label:'岗位',render:a=>agentName(ctx,a.agent_id)},{label:'动作状态',render:a=>state(a.state)},{label:'工具',key:'tool'}],record.actions),h('details',{},h('summary',{},'控制与核实记录'),h('pre',{},JSON.stringify(record,null,2)))),async()=>{
            if(!reason.value.trim())throw Error('请填写具体原因。');
            if(action.value==='resume'&&!prompt.value.trim())throw Error('请填写恢复后的明确要求。');
            await api('/v1/work/'+current.id+'/control','POST',{revision:current.revision,idempotencyKey:key,action:action.value,reason:reason.value.trim(),...(action.value==='wait'?{waitReason:'human_decision',question:question.value.trim()}:{}),...(action.value==='resume'?{assignments:[{agentId:target.value,prompt:prompt.value.trim()}]}:{})});
            toast('决定已记录，请查看工作当前状态');await reload();
        },{wide:true,saveLabel:'提交工作控制'});
    }
    async function reconcileWork(row){
        const current=await api('/v1/work/'+row.id),record=await api('/v1/work/'+row.id+'/control');
        const unknown=record.actions.filter(a=>a.state==='unknown');
        const selectedInput=h('pre',{},'选择动作后，显示该次操作的具体输入。');
        const target=select([{value:'',label:'本次不核实动作'},...unknown.map(a=>({value:a.id,label:agentName(ctx,a.agent_id)+' · '+a.tool+' · '+(a.input_preview??'参数待查看').slice(0,120)}))],'',async()=>{
            if(!target.value){selectedInput.textContent='本次不核实动作';return;}
            const chosen=target.value;
            try{const detail=await api('/v1/work/'+current.id+'/actions/'+chosen);if(target.value===chosen)selectedInput.textContent=JSON.stringify(detail.input??detail.inputExcerpt,null,2)+(detail.inputTruncated?'\n输入已截断，请按来源资料核实完整操作。':'');}catch(error){if(target.value===chosen)selectedInput.textContent=error.message;}
        });
        const outcome=select([{value:'succeeded',label:'已有证据确认成功'},{value:'not_executed',label:'已有证据确认未执行'}],'succeeded');
        const value=h('textarea',{rows:4,placeholder:'确认成功时填写真实完整回执 JSON，不要填写推测的结果。'});
        const reason=h('textarea',{rows:3,maxLength:1000,placeholder:'说明如何核实、核实了什么。'}),evidence=h('textarea',{rows:2,placeholder:'每行一条证据引用，例如外部回执编号或核查记录。'});
        const interrupted=current.assignments.filter(a=>a.state==='reconciliation_required'&&!record.reconciliations.some(r=>r.task_id===a.taskId));
        const closed=h('input',{type:'checkbox'}),key=idempotency();
        modal('人工核实未知执行',current.title,h('div',{},h('p',{},'这是人工确认记录。请先确认旧执行端已退出，并在外部系统核查真实结果；原来的未知记录仍会保留。'),field('本次核实的动作',target),field('所选操作的参数',selectedInput),field('核实结论',outcome),field('成功动作的原始回执',value),field('具体理由',reason),field('证据引用',evidence),interrupted.length?field('确认以下旧执行端均已关闭：'+interrupted.map(a=>agentName(ctx,a.agentId)).join('、'),closed):null,h('details',{},h('summary',{},'待核实技术记录'),h('pre',{},JSON.stringify(record,null,2)))),async()=>{
            const refs=evidence.value.split(/\r?\n/u).map(s=>s.trim()).filter(Boolean);if(!reason.value.trim()||!refs.length)throw Error('请填写核实理由和证据引用。');
            let receipt;if(target.value&&outcome.value==='succeeded'){try{receipt=JSON.parse(value.value);}catch{throw Error('请填写有效的真实回执 JSON。');}}
            const actions=target.value?[{actionId:target.value,outcome:outcome.value,...(outcome.value==='succeeded'?{value:receipt}:{})}]:[],tasks=closed.checked?interrupted.map(a=>({taskId:a.taskId,outcome:'closed'})):[];
            if(!actions.length&&!tasks.length)throw Error('请选择要核实的动作或确认旧执行端已关闭。');
            await api('/v1/work/'+current.id+'/reconcile','POST',{revision:current.revision,idempotencyKey:key,reason:reason.value.trim(),evidenceRefs:refs,actions,tasks});toast('人工核实已留存；恢复仍需明确批准');await reload();
        },{wide:true,saveLabel:'记录人工核实'});
    }
    async function inspect(row) {
        const current = await api('/v1/work/' + row.id);
        const reason = h('textarea', { rows: 3, required: true, maxLength: 1000, placeholder: '阅读各岗位结果后，填写核对依据或需要修改之处。' });
        const decision = select([{ value: 'approve', label: '结果符合要求' }, { value: 'reject', label: '结果需要调整' }], 'approve');
        const content = h('div', {}, h('p', {}, current.title), h('p', {}, '状态：', state(current.state), ' · 受限分配：' + current.restrictedAssignments), table([
            { label: '岗位 / 负责人', render: a => agentName(ctx, a.agentId) + ' / ' + employeeName(ctx, a.ownerId) }, { label: '状态', render: a => state(a.state) }, { label: '结果摘要', render: a => readableText(a.summary, { [a.agentId]: agentName(ctx, a.agentId), [a.ownerId]: employeeName(ctx, a.ownerId) }) },
            { label: '详情', render: a => button('查看完整结果', async () => { const record = await api('/v1/tasks/' + a.taskId); modal('岗位执行结果', agentName(ctx, a.agentId), record.result||record.resultPending?structuredResultView(record):resultView(record.output ?? '暂无结果', { names: { [a.agentId]: agentName(ctx, a.agentId), [a.ownerId]: employeeName(ctx, a.ownerId) }, technical: record }), null, { wide: true }); }, 'text') }
        ], current.assignments), current.review ? h('p', {}, '核对：' + employeeName(ctx, current.review.reviewed_by) + ' · ' + current.review.reason) : null);
        if (current.canReview) content.append(field('核对决定', decision), field('核对说明', reason), h('p', { class: 'field-hint' }, '记录这份工作结果的核对决定。业务发布仍需对应插件与写操作审批。'));
        modal('工作结果与核对', '请阅读各岗位结果后核对；执行凭证可在详情中展开。', content, current.canReview ? async () => { await api('/v1/work/' + current.id + '/review', 'POST', { revision: current.revision, decision: decision.value, reason: reason.value.trim() }); toast('核对决定已记录'); await reload(); } : null, { wide: true, saveLabel: '提交人工核对' });
    }
    function render() { box.replaceChildren(table([{ label: '工作', render: w => h('div', {}, w.title, ...(w.currentRound ? [h('p', { class: 'field-hint' }, '第' + w.currentRound + '轮')] : [])) }, { label: '发起人', render: w => employeeName(ctx, w.createdBy) }, { label: '状态', render: w => state(w.state) }, { label: '岗位', render: w => w.assignments.length + (w.restrictedAssignments ? ' / 部分受限' : '') }, { label: '期限', render: w => w.dueAt ? date(w.dueAt) : '—' }, { label: '操作', render: w => h('div', { class: 'button-row work-row-actions' }, button(w.canReview ? '查看并核对' : '查看结果', () => inspect(w), 'text', { 'data-emphasis': 'main' }), ...(w.currentRound ? [...(w.canControl?[button('工作控制',()=>controlWork(w),'text')]:[]),...(w.canReconcile&&w.state==='reconciliation_required'?[button('人工核实',()=>reconcileWork(w),'text')]:[]),button('查看轮次历史', () => history(w), 'text'), ...(w.canControl&&['waiting_review', 'changes_requested', 'completed'].includes(w.state) ? [button('继续 / 返工', () => continueWork(w), 'text')] : [])] : [])) }], rows.filter(w => !filter.value || w.state === filter.value), { empty: '还没有协作工作，可以先创建一项通用验证任务。' })); }
    async function reload() { const next = await api('/v1/work'); if (ctx.isCurrent?.() === false) return; rows = next; render(); }
    function dispatch() {
        const title = h('input', { required: true, maxLength: 160, placeholder: '工作目标' });
        const due = h('input', { type: 'datetime-local' });
        const prompts = agentOptions(ctx).map(o => ({ ...o, enabled: h('input', { type: 'checkbox' }), prompt: h('textarea', { rows: 2, maxLength: 8000, placeholder: '该岗位要完成什么、交付什么结果' }) }));
        const key = idempotency();
        modal('派发协作工作', '最多8个岗位并行执行，使用各自身份、插件、记忆和用量。', h('div', {}, field('工作标题', title), field('完成期限（本机时区，可不填）', due), prompts.map(o => h('div', {}, field(o.label, o.enabled), o.prompt))), async () => {
            const assignments = prompts.filter(o => o.enabled.checked).map(o => ({ agentId: o.value, prompt: o.prompt.value.trim() }));
            if (!assignments.length || assignments.length > 8 || assignments.some(a => !a.prompt)) throw Error('请选择1至8个岗位，并填写各自任务。');
            await api('/v1/work', 'POST', { title: title.value.trim(), assignments, idempotencyKey: key, ...(due.value ? { dueAt: new Date(due.value).toISOString() } : {}) }); toast('协作工作已进入队列'); await reload();
        }, { wide: true, saveLabel: '确认派工' });
    }
    render();
    return h('div', {}, heading('协作工作', '持久派工、并行执行和结果汇总。异常与未知结果保留真实状态。', ctx.canDispatch===false?null:button('派发工作', dispatch, 'primary')), h('div', { class: 'toolbar' }, filter, liveRefresh(ctx, reload)), panel('工作与结果', '负责人接收授权结果，不会把所有下级上下文装进一个 Agent。', box));
}
export async function assistantView(ctx) {
    const box = h('div');
    function editRule(rule) {
        const create = !rule; rule ??= { id: 'rule-' + Date.now().toString(36), eventType: 'work.issue', sourcePrincipalIds: [], assignments: [], enabled: true };
        const id = h('input', { value: rule.id, required: true, readOnly: !create, pattern: '[A-Za-z0-9][A-Za-z0-9_-]{0,63}' });
        const type = h('input', { value: rule.eventType, required: true, maxLength: 80 });
        const sources = checklist(ctx.employees.map(e => ({ value: e.id, label: employeeName(ctx, e.id) })), rule.sourcePrincipalIds);
        const target = select(agentOptions(ctx), rule.assignments[0]?.agentId);
        const prompt = h('textarea', { value: rule.assignments[0]?.prompt ?? '检查关联问题，使用已授权工具形成处理结果，等待负责人核对。', required: true, maxLength: 2000, rows: 4 });
        const enabled = h('input', { type: 'checkbox', checked: rule.enabled });
        if (rule.assignments.length > 1) { details('多目标规则', rule); return; }
        modal(create ? '新增辅助规则' : '编辑辅助规则', '只处理明确允许的事件来源。work.task_failed 用于已知失败的一次辅助处理；未知结果只通知。', h('div', {}, field('规则编号', id), field('事件类型', type), h('h3', {}, '允许哪些员工提供事件'), sources, field('处理岗位', target), field('处理要求', prompt), field('启用规则', enabled)), async () => {
            await api('/v1/admin/assistant/rules' + (create ? '' : '/' + rule.id), create ? 'POST' : 'PUT', { id: id.value, eventType: type.value.trim(), sourcePrincipalIds: checked(sources), assignments: [{ agentId: target.value, prompt: prompt.value.trim() }], enabled: enabled.checked, ...(!create ? { revision: rule.revision } : {}) }); toast('辅助规则已保存'); await reload();
        }, { wide: true });
    }
    function schedule() {
        const target = select(agentOptions(ctx)); const title = h('input', { required: true, maxLength: 160 }); const due = h('input', { type: 'datetime-local', required: true }); const background = h('textarea', { rows: 3, maxLength: 2000 }); const key = idempotency();
        modal('设置工作提醒', '到时进入对应员工收件箱，并保留事情的具体背景。', h('div', {}, field('接收岗位', target), field('提醒事项', title), field('提醒时间（本机时区）', due), field('背景与注意事项', background)), async () => { await api('/v1/assistant/reminders', 'POST', { agentId: target.value, title: title.value.trim(), dueAt: new Date(due.value).toISOString(), details: background.value, idempotencyKey: key }); toast('提醒已设置'); await reload(); });
    }
    async function reload() {
        const [reminders, rules, events, inbox] = await Promise.all([api('/v1/admin/assistant/reminders'), api('/v1/admin/assistant/rules'), api('/v1/admin/assistant/events'), api('/v1/assistant/inbox')]);
        if (ctx.isCurrent?.() === false) return;
        box.replaceChildren(panel('辅助处理规则', '事件 → 固定授权岗位 → 工作结果 → 人工核对；不会从事件文字扩大权限。', table([{ label: '规则', key: 'id' }, { label: '事件', key: 'eventType' }, { label: '来源', render: r => r.sourcePrincipalIds.map(id => employeeName(ctx, id)).join('、') }, { label: '处理岗位', render: r => r.assignments.map(a => agentName(ctx, a.agentId)).join('、') }, { label: '状态', render: r => badge(r.enabled ? '启用' : '停用') }, { label: '操作', render: r => button('编辑规则', () => editRule(r), 'text') }], rules), button('新增辅助规则', () => editRule(), 'secondary')),
            panel('定时提醒', '持久保存；重启后继续投递，每条只送达一次。', table([{ label: '事项', render: r => h('div', {}, r.title, h('p', { class: 'field-hint' }, r.details)) }, { label: '员工', render: r => employeeName(ctx, r.ownerId) }, { label: '时间', render: r => date(r.dueAt) }, { label: '状态', render: r => state(r.state) }, { label: '操作', render: r => r.state === 'pending' ? button('取消提醒', async () => { await api('/v1/assistant/reminders/' + r.id + '/cancel', 'POST', {}); await reload(); }, 'text') : '' }], reminders)),
            panel('问题事件', '查看事件来源、匹配规则与生成的工作编号。', table([{ label: '事件', key: 'type' }, { label: '来源', key: 'source' }, { label: '概要', render: e => e.data.summary }, { label: '状态', render: e => state(e.state) }, { label: '记录', render: e => button('查看回执', () => details('事件处理回执', e), 'text') }], events)),
            panel('我的通知', '这里显示当前管理员本人的待核对事项。员工通知在其接入窗口及 Harness 内查看。', table([{ label: '通知', render: n => n.data.title }, { label: '类型', key: 'kind' }, { label: '状态', render: n => n.readAt ? '已读' : '未读' }, { label: '操作', render: n => button('查看通知', async () => { details('通知', n.data); if (!n.readAt) await api('/v1/assistant/inbox/' + n.id + '/read', 'POST', {}); }, 'text') }], inbox)));
    }
    await reload();
    return h('div', {}, heading('工作辅助 Bot', '通用事件、到期提醒和异常处理。具体客户与业务接口由独立插件接入。', button('设置提醒', schedule, 'primary')), liveRefresh(ctx, reload), box);
}



