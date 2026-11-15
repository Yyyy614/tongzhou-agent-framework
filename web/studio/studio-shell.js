import{h,icon,button,avatar,modal}from'./ui.js';
export const routeGroups=[['工作',['overview','work','assistant']],['团队',['organization','employees','agents']],['能力与知识',['plugins','memory']],['连接',['entries','channels']],['记录',['logs','usage']]];
export function studioShell({me,state,routes,root,brand,closeSidebar,refresh,logout,search}){
    const nav=h('nav',{'aria-label':'管理后台导航'});
    for(const[label,ids]of routeGroups){const items=routes.filter(r=>ids.includes(r.id)).sort((a,b)=>ids.indexOf(a.id)-ids.indexOf(b.id));if(!items.length)continue;nav.append(h('section',{class:'studio-nav-group'},h('h2',{},label),...items.map(r=>h('a',{href:'#'+r.id,'data-route':r.id,'aria-label':r.name,title:r.name,onClick:closeSidebar,class:r.id===state.page?'active':''},icon(r.icon,19),h('span',{class:'nav-name'},r.name),r.count?h('span',{class:'nav-count','data-count':r.count},'—'):null))));}
    const sidebar=h('aside',{class:'sidebar',id:'workspace-navigation'},brand(),nav,h('div',{class:'sidebar-bottom'},h('div',{class:'account'},avatar(me.displayName==='admin'?'管':me.displayName),h('div',{},h('strong',{},me.displayName==='admin'?'管理员':me.displayName),h('small',{},'公司管理')),button(icon('logout',17),logout,'icon-button',{'aria-label':'退出登录'}))));
    const breadcrumb=h('strong',{},'工作空间'),main=h('main',{class:'main',id:'main-content',tabIndex:-1});
    const toggle=button(icon('menu',19),event=>{
        if(innerWidth<760){const open=sidebar.classList.toggle('open');event.currentTarget.setAttribute('aria-expanded',String(open));}
        else{const collapsed=layout.classList.toggle('sidebar-collapsed');event.currentTarget.setAttribute('aria-expanded',String(!collapsed));}
    },'icon-button',{'aria-label':'切换侧栏','aria-controls':'workspace-navigation','aria-expanded':String(innerWidth>=760)});
    const topbar=h('header',{class:'topbar'},
        h('div',{class:'breadcrumb'},toggle,h('span',{class:'studio-breadcrumb-company'},'公司管理'),icon('chevron',12),breadcrumb),
        h('div',{class:'top-actions'},
            button(h('span',{class:'studio-search-label'},icon('search',17),h('span',{},'搜索工作空间'),h('kbd',{},'Ctrl K')),search,'studio-search',{'aria-label':'搜索工作空间'}),
            button(icon('refresh',17),refresh,'icon-button',{'aria-label':'刷新页面'}),avatar(me.displayName==='admin'?'管':me.displayName)));
    const layout=h('div',{class:'layout studio-layout'},sidebar,h('div',{class:'main-shell'},topbar,main));
    root.replaceChildren(layout);return{nav,sidebar,breadcrumb,main};
}
export function searchWorkspace({routes,employees,agents,navigate,state}){
    const input=h('input',{type:'search',placeholder:'查找页面、员工或岗位','aria-label':'搜索页面、员工或岗位',autocomplete:'off'}),results=h('div',{class:'studio-search-results'});
    const entries=[...routes.map(r=>({name:r.name,detail:'工作空间',route:r.id,icon:r.icon})),...employees.map(e=>({name:e.displayName??e.id,detail:'员工 · 打开员工管理',route:'employees',icon:'people'})),...agents.map(a=>({name:a.displayName??a.id,detail:'岗位 · 打开 Agent 管理',route:'agents',icon:'bot'}))];
    let dialog;const render=()=>{const term=input.value.trim().toLowerCase(),found=entries.filter(e=>(e.name+' '+e.detail).toLowerCase().includes(term)).slice(0,14);results.replaceChildren(...(found.length?found.map(e=>button(h('span',{class:'studio-search-result'},icon(e.icon,18),h('span',{},h('strong',{},e.name),h('small',{},e.detail))),()=>{dialog.close();navigate(e.route);},'studio-search-item')):[h('p',{class:'studio-search-empty'},'没有找到匹配项，试试页面、员工或岗位名称。')]));};input.addEventListener('input',render);render();dialog=modal('搜索工作空间','快速前往你需要的功能；可用 Esc 返回当前工作。',h('div',{class:'studio-command-palette'},input,results),null);input.focus();
}
