export * from './base-ui.js';
import {modal as baseModal,h} from './base-ui.js';

// Presentation only: retain the existing controls, listeners and revisioned save closures.
export function modal(title,description,body,onSave,options){
    const previous=document.activeElement;
    const dialog=baseModal(title,description,body,onSave,options);
    dialog.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dialog.close();}},true);
    dialog.addEventListener('close',()=>{if(previous?.isConnected)previous.focus();},{once:true});
    if(['新增员工','编辑员工','创建 Agent','配置 Agent'].includes(title))queueMicrotask(()=>{
        if(!dialog.isConnected)return;
        const grids=[...body.children].filter(n=>n.classList.contains('form-grid'));
        const organization=grids.find(n=>n.textContent.startsWith('组织部门'));
        if(organization&&grids[1])grids[1].after(organization);
        for(const heading of [...body.querySelectorAll(':scope > h3.section-label')]){
            const label=heading.textContent;
            if(label==='岗位职责'||label==='基础插件')continue;
            const content=heading.nextElementSibling;if(!content)continue;
            const summary=h('summary',{}),group=h('details',{class:'studio-form-section'},summary);
            const update=()=>{const all=content.querySelectorAll('input[type=checkbox]'),count=content.querySelectorAll('input[type=checkbox]:checked').length;summary.textContent=label+(all.length?' · 已选择 '+count+' 项':'');};
            heading.before(group);group.append(content);heading.remove();content.addEventListener('change',update);update();
            if(title==='创建 Agent'&&label.includes('工具'))group.open=true;
        }
        for(const field of body.querySelectorAll(':scope > .field')){
            if(field.querySelector('textarea.json-input')){const group=h('details',{class:'studio-form-section'},h('summary',{},'插件配置 · JSON'));field.before(group);group.append(field);}
        }
    });
    return dialog;
}
