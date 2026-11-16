import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { installCaption } from './caption.mjs';
if(process.isMainFrame&&location.protocol==='dsh-app:'&&['app','company'].includes(location.hostname)){
    if(process.argv.includes('--company-integrated-chrome'))installCaption();
    contextBridge.exposeInMainWorld('companyHarness',{
        invoke:(method,input)=>ipcRenderer.invoke('company:call',method,input),
        async call(method,input){const response=await ipcRenderer.invoke('company:call',method,input);if(!response.ok)throw Object.assign(new Error(response.error.message),{code:response.error.code,status:response.error.status});return response.result;},
        onNavigate(listener){const handler=(_event,command)=>{if(command==='work-center')listener(command);};ipcRenderer.on('company:navigate',handler);return()=>ipcRenderer.removeListener('company:navigate',handler);},
    });
    contextBridge.exposeInMainWorld('dshDesktopBoot',{ready:()=>ipcRenderer.invoke('dsh-desktop:boot'),failed:()=>ipcRenderer.invoke('dsh-desktop:boot-failed')});
    contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__',{pick:()=>ipcRenderer.invoke('company:directory')});
    contextBridge.exposeInMainWorld('__DSH_HOST_PATHS__',{pathFor:file=>webUtils.getPathForFile(file)});
}
