import{api}from'./api.js';
import{h,button,field,select,modal,toast,heading,panel,table,badge,liveRefresh}from'./ui.js';
const eventStates={pending:'等待受理',processing:'正在受理',waiting:'等待工作结果',response_ready:'等待状态回复',error_ready:'等待错误回复',replied:'已回复',rejected:'命令未执行',result_unconfirmed:'工作结果待核实',blocked:'授权已失效，已拦截',replying:'等待发送回执',reply_unknown:'发送结果待核实'};
const providers={wecom:'企业微信',dingtalk:'钉钉',feishu:'飞书'};
const health={connected:'已认证连接',connecting:'连接中',disconnected:'已断开',connection_error:'连接失败，请核对凭证',reply_error:'回复回执待核实'};
export async function entryView(ctx){
    let mine=await api('/v1/entries/mine'),connections=ctx.me.role==='admin'?await api('/v1/admin/entries'):[];let events=await api('/v1/entries/events');const content=h('div');
    async function reload(){const next=await api('/v1/entries/mine'),all=ctx.me.role==='admin'?await api('/v1/admin/entries'):[];const nextEvents=await api('/v1/entries/events');if(ctx.isCurrent?.()===false)return;mine=next;connections=all;events=nextEvents;render();}
    function configure(existing){
        const provider=select(Object.entries(providers).map(([value,label])=>({value,label})),'dingtalk'),name=h('input',{required:true,maxLength:80,placeholder:'例如 公司钉钉测试机器人'}),publicId=h('input',{required:true,maxLength:128,autocomplete:'off'}),secret=h('input',{type:'password',required:true,maxLength:4096,autocomplete:'new-password'});
        if(existing){provider.value=existing.provider;provider.disabled=true;name.value=existing.name;publicId.value=existing.publicId;publicId.readOnly=true;} 
        modal('连接企业机器人','管理员配置一次，员工通过公司账号绑定自己的岗位。',h('div',{},field('平台',provider),field('连接名称',name),field('应用 ID / Bot ID',publicId),field('应用密钥 / Secret',secret),h('p',{class:'field-hint'},'钉钉填写 Client ID 和 Client Secret；飞书填写 App ID 和 App Secret。创建企业自建应用、启用机器人和长连接，先将可用范围限定为测试员工。')),async()=>{
            const credentials=provider.value==='dingtalk'?{clientId:publicId.value.trim(),clientSecret:secret.value}:provider.value==='feishu'?{appId:publicId.value.trim(),appSecret:secret.value}:{botId:publicId.value.trim(),secret:secret.value};
            await api('/v1/admin/entries'+(existing?'/'+existing.id:''),existing?'PUT':'POST',{name:name.value.trim(),credentials,...(existing?{revision:existing.revision}:{provider:provider.value})});secret.value='';toast('连接已保存，正在认证');await reload();
        },{saveLabel:'保存并连接'});
    }
    function wecomQr(){
        const name=h('input',{value:'公司企微测试助手',required:true,maxLength:80});
        modal('扫码创建企微机器人','使用企微官方授权流程，完成后自动取得并保存连接配置。',field('连接名称',name),async()=>{
            const session=await api('/v1/admin/entries/qr','POST',{name:name.value.trim()});
            setTimeout(()=>showQr(session),0);
        },{saveLabel:'生成企微授权二维码'});
    }
    function showQr(session){
        const status=h('p',{role:'status'},'等待使用企业微信扫码授权（5分钟有效）'),image=h('img',{src:session.qrImage,alt:'企业微信官方机器人授权二维码',width:280,height:280});
        const dialog=modal('企业微信扫码配置','用企业微信扫描并确认创建机器人。成功后，再绑定员工身份。',h('div',{},image,status),null);let timer;
        const poll=async()=>{if(!dialog.open)return;try{const result=await api('/v1/admin/entries/qr/'+session.id);if(!dialog.open)return;if(result.state==='connected'){status.textContent='扫码授权完成，连接已保存。请关闭窗口并在下方绑定本人身份。';await reload();return;}if(result.state==='expired'){status.textContent='二维码已过期，请关闭后重新生成。';return;}status.textContent='等待扫码或企微端确认…';}catch(error){status.textContent=error.message;if(['UNAUTHENTICATED','PERMISSION_DENIED'].includes(error.code)){dialog.close();ctx.sessionExpired?.(error);return;}}if(dialog.open)timer=setTimeout(poll,3000);};
        dialog.addEventListener('close',()=>clearTimeout(timer));timer=setTimeout(poll,3000);
    }
    function bind(){
        if(!mine.connections.length||!mine.agents.length){toast('需要已配置的连接和本人有效岗位。','error');return;}
        const connection=select(mine.connections.map(c=>({value:c.id,label:providers[c.provider]+' · '+c.name})),mine.connections[0].id),agent=select(mine.agents.map(a=>({value:a.id,label:a.name})),mine.agents[0].id);
        modal('绑定本人外部账号','每个外部账号只使用已确认的公司身份和岗位。',h('div',{},field('公司机器人',connection),field('本人岗位',agent)),async()=>{const pairing=await api('/v1/entries/bind','POST',{connectionId:connection.value,agentId:agent.value});setTimeout(()=>showBinding(pairing),0);},{saveLabel:'生成本人绑定码'});
    }
    function showBinding(pairing){
        const command='/bind '+pairing.code,status=h('p',{role:'status'},'请在机器人单聊发送上面的绑定指令，再回到这里确认。'),confirmation=h('div');
        const dialog=modal('确认外部账号','绑定码5分钟有效，请核对真实的平台用户编号，不能只看昵称。',h('div',{},h('pre',{},command),button('复制绑定指令',async()=>{await navigator.clipboard.writeText(command);toast('已复制');},'secondary'),status,confirmation),null);let timer;
        const poll=async()=>{if(!dialog.open)return;try{const result=await api('/v1/entries/bind/'+pairing.id);if(!dialog.open)return;if(result.state==='expired'){status.textContent='绑定码已过期，请重新生成。';return;}if(result.state==='claimed'){status.textContent='收到平台用户：'+result.candidate.externalUserId;confirmation.replaceChildren(button('确认这是我的账号',async()=>{await api('/v1/entries/bind/'+pairing.id+'/confirm','POST',{revision:result.revision});toast('外部账号已绑定');dialog.close();await reload();},'primary'));return;}}catch(error){status.textContent=error.message;}if(dialog.open)timer=setTimeout(poll,2000);};dialog.addEventListener('close',()=>clearTimeout(timer));timer=setTimeout(poll,1000);
    }
    function render(){content.replaceChildren(...(ctx.me.role==='admin'?[panel('公司机器人连接','群通知Webhook和双向机器人不同；这里使用官方长连接接收消息。',h('div',{},button('企微扫码创建',wecomQr,'primary'),button('配置钉钉 / 飞书 / 企微',()=>configure(),'secondary')),table([{label:'连接',key:'name'},{label:'平台',render:c=>providers[c.provider]},{label:'连接状态',render:c=>badge(c.enabled?(health[c.health?.state]??'等待连接'):'已停用')},{label:'配置',render:c=>h('div',{},button('修改密钥',()=>configure(c),'text'),button(c.enabled?'停用连接':'重新连接',async()=>{await api('/v1/admin/entries/'+c.id+'/enabled','POST',{revision:c.revision,enabled:!c.enabled});await reload();},'text'))}],connections))]:[]),panel('我的机器人账号','公司权限、私人记忆和用量继续按本人岗位隔离。',button('绑定本人账号',bind,'primary'),table([{label:'平台连接',render:b=>mine.connections.find(c=>c.id===b.connection_id)?.name??'连接已停用'},{label:'平台用户编号',key:'external_id'},{label:'岗位',render:b=>mine.agents.find(a=>a.id===b.agent_id)?.name??'岗位不可用'},{label:'状态',render:b=>b.active?'已绑定':'已撤销'},{label:'操作',render:b=>b.active?button('撤销绑定',async()=>{await api('/v1/entries/bindings/'+b.id+'/revoke','POST',{});await reload();},'text'):''}],mine.bindings)),panel('接入记录','显示最近50次受理和回复状态；正文仍在受权工作中。',table([{label:'平台',render:e=>providers[e.provider]},{label:'状态',render:e=>badge(eventStates[e.state]??e.state)},{label:'处理提示',render:e=>e.error?.code??'—'},{label:'工作',render:e=>e.work_id?button('打开工作中心',()=>ctx.navigate?.('work'),'text'):'—'}],events)),panel('开始使用','机器人和CLI共用Work接口。',h('p',{},'单聊直接发送任务；先发送 /status 查看本人工作编号与状态，再用 /stop W-000001 原因、/wait W-000001 原因、/resume W-000001 新要求 管理工作。群聊只返回状态，完整内容登录公司工作中心查看。')));}
    render();return h('div',{},heading('外部机器人与 CLI','配置公司连接，再确认员工身份，消息进入同一套受管工作。'),liveRefresh(ctx,reload),content);
}



