import{ipcRenderer,webFrame}from'electron';
import{productName}from'../packages/company-ui/brand.mjs';
import{captionHeight}from'./chrome.mjs';

/** The official AppFrame already owns Windows caption clearance and drag geometry. */
export function installCaption(){
    const install=()=>{
        const root=document.documentElement;
        root.dataset.windowsTitlebar='';root.dataset.companyChrome='';root.style.setProperty('--dsh-windows-titlebar-height',captionHeight+'px');
        if(location.hostname==='company')root.dataset.companyAccount='';
        void webFrame.insertCSS(`
            [data-company-account] body{padding-top:${captionHeight}px!important;box-sizing:border-box;min-height:100vh}
            [data-company-account] #app{min-height:calc(100vh - ${captionHeight}px)}
            .tz-caption{position:fixed;top:0;left:calc(env(titlebar-area-x,0px) + 48px);width:calc(env(titlebar-area-width,calc(100% - 144px)) - 48px);height:${captionHeight}px;z-index:1200;display:flex;align-items:center;gap:16px;padding:0 12px;box-sizing:border-box;-webkit-app-region:drag;font:12px/1.5 "Microsoft YaHei","Segoe UI",sans-serif;color:#67756e;user-select:none}
            [data-company-account] .tz-caption{left:env(titlebar-area-x,0px);width:env(titlebar-area-width,calc(100% - 144px));padding-left:18px}
            .tz-caption button{border:0;border-radius:7px;min-width:36px;height:32px;padding:4px 9px;color:inherit;background:none;cursor:pointer;-webkit-app-region:no-drag;font:inherit}
            .tz-caption button:hover{background:#63796e14}.tz-caption button:focus-visible{outline:2px solid #087f73;outline-offset:1px}.tz-caption-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none}
            body[data-ds-dark-theme] .tz-caption{color:#c3d0ca}body[data-ds-dark-theme] .tz-caption button:hover{background:#ffffff12}
        `);
        const host=document.createElement('header');host.className='tz-caption';
        const menu=document.createElement('button');menu.type='button';menu.textContent='•••';menu.setAttribute('aria-label','应用菜单');menu.setAttribute('aria-haspopup','menu');menu.setAttribute('aria-expanded','false');
        menu.addEventListener('click',async()=>{if(menu.getAttribute('aria-expanded')==='true')return;menu.setAttribute('aria-expanded','true');const rect=menu.getBoundingClientRect();try{await ipcRenderer.invoke('company:menu',{x:Math.round(rect.left),y:Math.round(rect.bottom)});}finally{menu.setAttribute('aria-expanded','false');}});
        const label=document.createElement('span');label.className='tz-caption-label';label.textContent=productName;
        ipcRenderer.on('company:caption',(_event,title)=>{if(typeof title==='string')label.textContent=title.slice(0,160);});
        host.append(menu,label);document.body.append(host);
        let lastDark;const sync=()=>{const dark=document.body.hasAttribute('data-ds-dark-theme');if(dark!==lastDark){lastDark=dark;ipcRenderer.send('company:appearance',dark);}};
        const observer=new MutationObserver(sync);observer.observe(document.body,{attributes:true,attributeFilter:['data-ds-dark-theme']});sync();
        window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});
    };
    if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',install,{once:true});else install();
}
