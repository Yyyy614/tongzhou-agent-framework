import {api} from './api.js';
import {h,button,modal,toast} from './ui.js';
export function structuredResultView(record){
    const result=record.result;
    if(!result)return h('p',{},record.resultPending?'执行记录正在整理或需要核实，原始过程未作为管理摘要回传。':record.output??'暂无结果');
    const body=h('div',{},h('p',{},result.summary),h('p',{class:'muted'},'状态来自宿主回执；Agent 报告的事实仍需按来源人工核对。'));
    const read=ref=>button(ref.title?'查看资料：'+ref.title+' · 版本 '+ref.version:'按权限读取本人完整回复',async()=>{try{let page=await api('/v1/resources/'+ref.id+'?version='+ref.version);const text=h('pre',{class:'json-detail'},page.body),next=button('继续读取',async()=>{try{page=await api('/v1/resources/'+ref.id+'?version='+ref.version+'&offset='+page.nextOffset);text.textContent+=page.body;next.hidden=!page.nextOffset;}catch(e){toast(e.message,'danger');}});next.hidden=!page.nextOffset;modal(page.title,'来源按当前权限重新校验；旧版本引用不会自动变成新版本。',h('div',{},text,next),null,{wide:true});}catch(e){toast(e.message,'danger');}});
    for(const fact of result.facts)body.append(h('section',{},h('p',{},fact.text),h('small',{class:'muted'},fact.freshness==='current'?'引用当前有效':'引用来源已变化，需核实'),...fact.refs.map(read)));
    for(const ref of result.artifacts)body.append(read(ref));
    for(const issue of result.issues)body.append(h('p',{class:'notice'},'待处理：'+issue));
    if(result.processRef)body.append(h('details',{},h('summary',{},'本人完整回复与过程'),read(result.processRef)));
    return body;
}
