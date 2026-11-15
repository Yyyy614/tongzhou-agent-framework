import{productName,brandMark}from './brand.mjs';
import{h,icon,button,avatar}from'./ui.js';
export function studioEmployeeShell({root,me,state,entryEnabled,navigate,logout}){
    const main=h('main',{class:'main',id:'main-content',tabIndex:-1});
    const nav=h('nav',{'aria-label':'员工工作中心'},button([icon('activity',19),'我的工作'],()=>navigate('work'),'studio-employee-link'),...(entryEnabled?[button([icon('link',19),'连接机器人'],()=>navigate('entries'),'studio-employee-link')]:[]));
    root.replaceChildren(h('div',{class:'layout studio-layout studio-employee-layout'},
        h('aside',{class:'sidebar'},h('div',{class:'brand'},h('span',{class:'brand-mark'},h('img',{src:brandMark,alt:''})),h('strong',{},productName)),h('div',{class:'studio-role'},avatar(me.displayName),h('strong',{},me.displayName),h('p',{},'本人工作与受权协作')),nav,h('div',{class:'sidebar-bottom'},h('p',{class:'studio-private-note'},icon('shield',16),'本人记忆与岗位保持独立'),button([icon('logout',17),'退出账号'],logout,'secondary'))),
        h('div',{class:'main-shell'},h('header',{class:'topbar'},h('strong',{},'员工工作中心'),h('div',{class:'studio-mobile-employee'},button('我的工作',()=>navigate('work'),'secondary'),...(entryEnabled?[button('连接机器人',()=>navigate('entries'),'secondary')]:[]),button('退出',logout,'secondary')),h('span',{class:'studio-caption'},'公司账号 · '+me.displayName)),main)));
    return main;
}
