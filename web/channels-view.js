import { api } from './api.js';
import { h,button,field,select,modal,toast,heading,panel,table,badge,liveRefresh } from './ui.js';
const fields=['id','name','kind','protocol','provider','baseURL','model','accountGroup','maxConcurrency','priority','enabled','scope','departmentId','ownerId','documentation','revision'];
export async function channelsView(ctx){
    let data=await api('/v1/admin/channels');const box=h('div');
    function edit(channel){
        const create=!channel;channel??={id:'channel-'+Date.now().toString(36),name:'',kind:'model',protocol:'anthropic',provider:'deepseek',baseURL:'https://api.deepseek.com/anthropic',model:'deepseek-flash',accountGroup:'company-main',maxConcurrency:3,priority:10,enabled:true,scope:'company',documentation:''};
        const id=h('input',{value:channel.id,required:true,readOnly:!create,pattern:'[A-Za-z0-9][A-Za-z0-9_-]{0,63}'});
        const name=h('input',{value:channel.name,required:true,maxLength:80});
        const kind=select([{value:'model',label:'模型渠道'},{value:'plugin',label:'插件 / 平台接口'}],channel.kind,undefined,{disabled:!create});
        const protocol=select([{value:'anthropic',label:'Anthropic兼容模型API'},{value:'company-jsonrpc',label:'公司插件 JSON-RPC 1.0'},{value:'http',label:'HTTP平台接口（配套插件适配）'}],channel.protocol);
        kind.addEventListener('change',()=>protocol.value=kind.value==='model'?'anthropic':'http');
        const provider=h('input',{value:channel.provider,required:true,pattern:'[A-Za-z0-9][A-Za-z0-9_-]{0,63}'}),url=h('input',{value:channel.baseURL,required:true,type:'url'}),model=h('input',{value:channel.model??'',maxLength:100});
        const group=h('input',{value:channel.accountGroup,required:true,pattern:'[A-Za-z0-9][A-Za-z0-9_-]{0,63}'}),limit=h('input',{value:channel.maxConcurrency,type:'number',min:1,max:128,required:true}),priority=h('input',{value:channel.priority,type:'number',min:0,max:100,required:true});
        const scope=select([{value:'company',label:'公司官方渠道'},{value:'department',label:'指定部门渠道'},{value:'personal',label:'指定员工专用渠道'}],channel.scope,undefined,{disabled:!create});
        const department=select([{value:'',label:'选择部门'},...ctx.departments.map(d=>({value:d.id,label:d.name}))],channel.departmentId??'');
        const owner=select([{value:'',label:'选择员工'},...ctx.employees.map(e=>({value:e.id,label:e.displayName??e.id}))],channel.ownerId??'',undefined,{disabled:!create&&channel.scope==='personal'});
        const secret=h('input',{type:'password',autocomplete:'new-password',maxLength:4096,placeholder:channel.hasCredential?'已配置；留空保留现有凭证':'填写API Key或服务Token'});
        const documentation=h('textarea',{value:channel.documentation??'',rows:7,maxLength:16000,placeholder:'用途、接口协议、调用样例、输入输出、异步任务状态、插件配置说明。不填写密钥。'}),enabled=h('input',{type:'checkbox',checked:channel.enabled});
        modal(create?'新增公司渠道':'编辑渠道', '凭证写入后不回显。相同DeepSeek账号的Key使用同一个账号组，共享并发额度。',h('div',{},h('div',{class:'form-grid'},field('渠道名称',name),field('引用编号',id),field('资源用途',kind),field('协议',protocol),field('提供商编号',provider),field('接口地址',url),field('模型名称',model,'模型渠道应与当前宿主配置的模型名称一致。'),field('账号组',group),field('同账号最大并发',limit,'同一账号组的所有Key必须填写相同值。'),field('优先级',priority,'数字小的优先，满载或明确拒绝时调度其他账号。'),field('使用范围',scope),field('指定部门',department),field('专用员工',owner)),field('接口凭证',secret),field('接口文档与配置说明',documentation),field('启用渠道',enabled),h('p',{class:'field-hint'},'HTTP平台需要配套插件适配；保存地址不表示已完成生图或视频能力接入。个人专用凭证在公司服务端加密，仅对应员工调用。')),async()=>{
            const payload={...Object.fromEntries(fields.filter(k=>channel[k]!==undefined).map(k=>[k,channel[k]])),id:id.value,name:name.value.trim(),kind:kind.value,protocol:protocol.value,provider:provider.value,baseURL:url.value.trim(),accountGroup:group.value,maxConcurrency:Number(limit.value),priority:Number(priority.value),scope:scope.value,enabled:enabled.checked,documentation:documentation.value};
            if(model.value.trim())payload.model=model.value.trim();else delete payload.model;
            if(scope.value==='department')payload.departmentId=department.value;else delete payload.departmentId;
            if(scope.value==='personal')payload.ownerId=owner.value;else delete payload.ownerId;
            if(secret.value)payload.apiKey=secret.value;
            await api('/v1/admin/channels'+(create?'':'/'+channel.id),create?'POST':'PUT',payload);secret.value='';toast('渠道配置已保存');await reload();
        },{wide:true});
    }
    function render(){
        box.replaceChildren(panel('渠道资源', '模型按账号组调度；插件只引用授权连接，员工不会拿到公司总密钥。',table([{label:'渠道',key:'name'},{label:'用途',render:c=>c.kind==='model'?'模型':'插件 / 平台'},{label:'范围',render:c=>({company:'全公司',department:'指定部门',personal:'专用员工'})[c.scope]},{label:'账号组 / 并发',render:c=>c.accountGroup+' · '+(c.accountActiveRequests??c.activeRequests)+' / '+c.maxConcurrency},{label:'凭证',render:c=>badge(c.hasCredential?'已配置':'未配置')},{label:'状态',render:c=>badge(!c.enabled?'已停用':c.cooldownUntil&&Date.parse(c.cooldownUntil)>Date.now()?'暂时冷却':'可用')},{label:'近7天用量',render:c=>(c.usage?.requests??0)+' 次 / '+(c.usage?.unmeasured?'部分用量待核实':(Number(c.usage?.input_tokens??0)+Number(c.usage?.output_tokens??0)).toLocaleString()+' tokens')},{label:'最近响应',render:c=>c.lastStatus??'尚未调用'},{label:'操作',render:c=>button('配置',()=>edit(c),'text')}],data.channels)));
    }
    async function reload(){const next=await api('/v1/admin/channels');if(ctx.isCurrent?.()===false)return;data=next;render();}
    render();return h('div',{},heading('渠道与接口', '统一管理公司模型账号、插件连接与接口说明。默认显示凭证状态，不回显Key。',button('新增渠道',()=>edit(),'primary')),h('p',{class:'notice'},'宿主运行并发由部署配置决定；账号池不能扩大单个账号的服务商额度。当前每位员工最多同时发送 '+data.limits.perEmployeeModelRequests+' 个模型请求。'),liveRefresh(ctx,reload),box);
}
