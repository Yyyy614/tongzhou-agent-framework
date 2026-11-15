import{api}from'./api.js';
import{h,button,heading,icon,badge,number,date,liveRefresh,empty}from'./ui.js';
import{resultView}from'./result-view.mjs';
const names={queued:'排队中',running:'执行中',waiting_review:'等待核对',completed:'已核对',changes_requested:'需要调整',waiting:'等待人工或依赖',stop_requested:'正在停止',stopped:'已停止',reconciliation_required:'结果待核实',needs_attention:'需要处理'};
export async function studioOverview(ctx){
    const body=h('div');
    async function load(){
        const[overview,works,usage]=await Promise.all([api('/v1/admin/overview'),api('/v1/work'),api('/v1/admin/usage?days=7')]);if(ctx.isCurrent?.()===false)return;
        const pending=works.filter(w=>w.canReview&&w.state==='waiting_review'),attention=works.filter(w=>['reconciliation_required','needs_attention','waiting'].includes(w.state));
        const goWork=(filter='')=>{ctx.state.workFilter=filter;ctx.navigate('work');};
        const workRow=w=>h('article',{class:'studio-work-row'},h('div',{class:'studio-work-symbol'},icon(w.state==='stopped'?'shield':'file',21)),h('div',{class:'grow'},h('h3',{},w.title),h('p',{class:'studio-caption'},[...new Set(w.assignments.map(a=>a.ownerName??ctx.employees.find(e=>e.id===a.ownerId)?.displayName??'受权岗位'))].join('、')+' · 第'+w.currentRound+'轮')),badge(names[w.state]??'需要查看',['waiting_review','waiting'].includes(w.state)?'warning':w.state==='completed'?'success':'neutral'),button('查看工作',()=>goWork(w.state),'text'));
        const focus=h('section',{class:'studio-panel studio-focus'},h('div',{class:'studio-panel-heading'},h('h2',{},pending.length?'需要你核对的工作':'工作与协作'),badge(pending.length?pending.length+'项待核对':'当前状态')),works.length?h('div',{},...pending.slice(0,3).map(w=>h('article',{class:'studio-focus-work'},h('div',{class:'studio-line'},badge('等待核对','warning'),h('span',{class:'studio-caption'},'第'+w.currentRound+'轮执行')),h('h2',{},w.title),h('div',{class:'studio-result'},resultView(w.assignments.map(a=>a.summary).filter(Boolean).join('\n').slice(0,450)||'执行已完成，请进入工作详情核对各岗位结果。')),h('div',{class:'studio-line spread'},h('span',{class:'studio-caption'},'执行历史和原始回执持续保留'),button('查看并核对',()=>goWork('waiting_review'),'primary')))),h('div',{},...works.filter(w=>!pending.some(p=>p.id===w.id)).slice(0,4).map(workRow))):empty('从一项工作开始','创建员工、配置岗位，再把工作交给相应 Agent。',button('配置员工',()=>ctx.navigate('employees'),'primary')));
        const counts=overview.counts;
        const status=h('section',{class:'studio-system'},h('div',{},h('strong',{},number(counts.activeEmployees)),h('span',{},'启用员工')),h('div',{},h('strong',{},number(counts.activeAgents)),h('span',{},'启用岗位')),h('div',{},h('strong',{},number(counts.plugins)),h('span',{},'已安装插件')),h('div',{},h('strong',{},number(usage.totals.requests)),h('span',{},'近7日模型请求')));
        const shortcuts=[['people','成员与岗位','建立身份，分配工作职责','employees'],['box','插件与能力','配置岗位可调用的工具','plugins'],['link','公司连接','机器人、模型和公司接口','channels']].map(([i,title,desc,page])=>button(h('span',{class:'studio-shortcut-content'},icon(i,22),h('span',{},h('strong',{},title),h('small',{},desc))),()=>ctx.navigate(page),'studio-shortcut'));
        const recent=(overview.recentRuns??[]).slice(0,5).map(r=>h('div',{class:'studio-activity-row'},
            h('span',{class:'status-dot'}),h('div',{},
                h('strong',{},ctx.agents.find(a=>a.id===r.agentId)?.displayName??'岗位执行'),
                h('p',{},({succeeded:'已完成',cancelled:'已取消',running:'执行中',reconciliation_required:'结果待核实',failed:'执行失败'})[r.state]??'已记录'),
                h('small',{},date(r.createdAt)))));
        const next=h('section',{class:'studio-next'},h('h3',{},'接下来'),
            h('p',{},attention.length?attention.length+'项工作需要人工决定或核实。':pending.length?'先看执行结果，再留下你的核对依据。':'岗位与能力准备好后，可以开始派发工作。'),
            button(attention.length?'查看需要处理的工作':pending.length?'前往核对':'派发协作工作',()=>goWork(attention.length?attention[0].state:pending.length?'waiting_review':''),'secondary'));
        const aside=h('aside',{class:'studio-overview-aside'},next,
            h('section',{class:'studio-activity'},h('h3',{},'最近执行'),recent),
            h('p',{class:'studio-private-note'},icon('shield',16),'私人记忆按独立授权读取；管理关系不自动扩大访问范围。'));
        body.replaceChildren(status,h('div',{class:'studio-overview-grid'},h('div',{},focus,h('h2',{class:'studio-section-title'},'让下一次协作更顺畅'),h('div',{class:'studio-shortcuts'},shortcuts)),aside));
    }
    await load();return h('div',{},heading('把需要处理的事，放到眼前。','从工作结果出发，再按需配置组织与能力。',liveRefresh(ctx,load)),body);
}
