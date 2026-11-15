import{productName,productTagline,brandMark}from'../../packages/company-ui/brand.mjs';
const root=document.querySelector('#app'),api=window.companyHarness;
let mode='login',busy=false,state,phase='loading',selected='',notice=new URLSearchParams(location.hash.slice(1)).get('notice')??'';
const draft={username:'',code:'',deviceName:'公司电脑'};
const el=(name,props={},...children)=>{const n=document.createElement(name);for(const[k,v]of Object.entries(props)){if(k.startsWith('on'))n.addEventListener(k.slice(2),v);else if(k in n)n[k]=v;else n.setAttribute(k,v);}n.append(...children.flat().filter(v=>v!==undefined&&v!==null).map(v=>typeof v==='string'?document.createTextNode(v):v));return n;};
const brand=()=>el('div',{className:'brand'},el('span',{className:'brand-mark','aria-hidden':'true'},el('img',{src:brandMark,alt:''})),el('div',{},el('strong',{},productName),el('span',{},productTagline)));
function render(){
    const side=el('aside',{className:'welcome-side'},brand(),el('div',{className:'welcome-intro'},el('h1',{},'专注你的工作。',el('br'), '其余交给同舟。'),el('p',{},'同一个工作空间，连接岗位、能力和记忆。'),el('div',{className:'welcome-capabilities'},...['你的岗位，独立的工作上下文','授权能力，始终清楚可控','工作记录，随时回来继续'].map((s,i)=>el('div',{},el('span',{'aria-hidden':'true'},['◇','⌘','↻'][i]),s)))),el('footer',{},el('span',{className:'status-dot'}),'公司内部工作空间'));
    const content=el('section',{className:'welcome-content'}),message=el('div',{className:'notice',role:'status'},notice);
    root.replaceChildren(side,content);
    if(phase!=='ready'){content.append(el('div',{className:'auth-card'},el('h2',{},phase==='loading'?'正在连接公司服务':'暂时无法连接'),el('p',{className:'intro'},phase==='loading'?'正在确认这台电脑的登录状态…':'请确认公司服务可访问后重新连接。'),message,...(phase==='error'?[el('button',{className:'primary',onclick:loadState},'重新连接')]:[])));return;}
    const card=el('div',{className:'auth-card'});content.append(card);
    if(state.authenticated){
        selected=state.agents.some(a=>a.id===selected)?selected:state.activeAgentId??state.agents[0]?.id??'';
        card.append(el('h2',{},'你好，'+(state.employee.displayName??'同事')),el('p',{className:'intro'},'选择当前负责的岗位，进入自己的工作空间。'));
        const choices=el('fieldset',{className:'job-choices'},el('legend',{},'分配给你的岗位'),...state.agents.map(a=>el('label',{className:'job-choice'},el('input',{type:'radio',name:'job',value:a.id,checked:a.id===selected,disabled:busy,onchange:()=>{selected=a.id;}}),el('div',{},el('strong',{},a.displayName),el('span',{},a.presetName??'公司岗位预设')),el('span',{className:'job-selected','aria-hidden':'true'},'✓'))));
        card.append(choices,...(!state.agents.length?[el('p',{className:'notice'},'尚未分配岗位，请联系管理员。')]:[]),message,el('button',{className:'primary',disabled:busy||!state.agents.length,onclick:()=>perform(async()=>{try{await api.call('select',{agentId:selected});}catch(e){if(e.code!=='WORK_RUNNING'||!confirm('当前岗位仍有工作。确认停止并核对已有结果后切换吗？'))throw e;await api.call('select',{agentId:selected,stopActive:true});}})},busy?'正在准备工作台…':'进入工作空间'),el('div',{className:'actions'},...(state.activeAgentId?[el('button',{disabled:busy,onclick:()=>perform(()=>api.call('workspace'))},'返回当前岗位'),el('button',{disabled:busy,onclick:()=>perform(()=>api.call('select',{agentId:state.activeAgentId,refresh:true}))},'刷新岗位与权限')]:[]),el('button',{disabled:busy,onclick:()=>perform(async()=>{await api.call('logout');state=await api.call('state');selected='';})},'退出账号')));
    }else{
        card.append(el('h2',{},mode==='login'?'登录公司账号':'首次接入'),el('p',{className:'intro'},mode==='login'?'使用内部账号，继续你的工作。':'输入管理员提供的一次性接入码，设置自己的密码。'));
        const user=el('input',{name:mode==='login'?'username':'code',value:draft[mode==='login'?'username':'code'],autocomplete:mode==='login'?'username':'off',required:true,maxLength:160,disabled:busy,oninput:e=>{draft[mode==='login'?'username':'code']=e.target.value;}});
        const password=el('input',{name:'password',type:'password',autocomplete:mode==='login'?'current-password':'new-password',required:true,maxLength:128,disabled:busy});
        const device=el('input',{name:'deviceName',value:draft.deviceName,required:true,maxLength:80,disabled:busy,oninput:e=>{draft.deviceName=e.target.value;}});
        card.append(el('form',{onsubmit:e=>{e.preventDefault();const value=password.value;perform(async()=>{state=await api.call(mode,{[mode==='login'?'username':'code']:user.value.trim(),password:value,deviceName:device.value.trim()});if(state.agents.length===1)await api.call('select',{agentId:state.agents[0].id});});}},el('label',{},mode==='login'?'员工账号':'一次性接入码',user),el('label',{},mode==='login'?'密码':'设置密码（至少12个字符）',password),el('label',{},'这台电脑的名称',device),message,el('button',{type:'submit',className:'primary',disabled:busy},busy?'正在连接…':mode==='login'?'登录工作空间':'完成接入'),el('button',{type:'button',className:'text-button',disabled:busy,onclick:()=>{mode=mode==='login'?'register':'login';notice='';render();}},mode==='login'?'首次接入或重置密码':'已有账号，返回登录')));
    }
    content.append(el('div',{className:'connection'},el('span',{className:'status-dot'}),el('span',{},state.serverURL),' · 连接公司服务'));
}
async function perform(action){if(busy)return;busy=true;notice='';render();try{await action();}catch(e){notice=e.message;}finally{busy=false;render();}}
async function loadState(){phase='loading';render();try{state=await api.call('state');phase='ready';}catch(e){notice=e.message;phase='error';}render();}
await loadState();
