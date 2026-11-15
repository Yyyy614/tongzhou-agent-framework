import { app, BrowserWindow, ipcMain, Menu, protocol, session as electronSession, safeStorage, dialog } from 'electron';
import { readFile, mkdir, cp, writeFile, lstat, realpath, symlink, appendFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { DesktopHostProcess } from '../vendor/harness-desktop/host-process.ts';
import { DesktopProjectManager } from '../vendor/harness-desktop/project-manager.ts';
import { serveWebDocument, authenticateWebHost, forwardWebRequest, removeLegacyHostCookies } from '../vendor/harness-desktop/web-document.ts';
import { prepareHarnessProfile } from '../dist/harness-profile.js';
import { createCompanySession } from '../client/company-session.mjs';
import { desktopChrome, captionMenuPoint } from './chrome.mjs';

protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
const root = app.getAppPath();
const config = JSON.parse(await readFile(join(root, 'company.json'), 'utf8'));
const scope = createHash('sha256').update(config.serverURL).digest('hex').slice(0,20);
if(config.dataNamespace!==undefined&&!/^[A-Za-z0-9_-]{1,40}$/u.test(config.dataNamespace))throw Error('Invalid company data namespace');
const dataDir = resolve(config.dataDir ?? join(app.getPath('appData'), 'CompanyHarness', config.dataNamespace??'default', scope));
const productName=config.productName??'公司 Agent Harness';
app.setName(productName);
if(config.integratedChrome===true&&process.platform==='win32')app.setAppUserModelId('com.tongzhou.studio');
app.setPath('userData', join(dataDir, 'electron'));
await mkdir(app.getPath('userData'), { recursive: true });
if (!app.requestSingleInstanceLock()) app.exit(0);
else void run().catch(() => { dialog.showErrorBox(productName,'客户端启动未完成，请检查隔离服务或重新打开软件');app.exit(1); });

async function run() {
    await app.whenReady();
    if (!safeStorage.isEncryptionAvailable()) throw Error('Windows credential protection is unavailable');
    const window = new BrowserWindow({ width: 1240, height: 860, minWidth: 800, minHeight: 620, title: productName, backgroundColor: '#f5f7f8',...(config.integratedChrome===true?{icon:join(root,'assets/icon.png')}:{}),...desktopChrome(config,process.platform),webPreferences: { preload: join(root,'lib/company-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,additionalArguments:config.integratedChrome===true&&process.platform==='win32'?['--company-integrated-chrome']:[] } });
    window.on('page-title-updated',event=>event.preventDefault());
    let ownedHost, hostURL, hostCookie, injections = [], quitting = false, changeGeneration = 0;
    const trace=async(stage,error)=>{
        const detail=error?String(error.message).replace(/fw_[A-Za-z0-9_.-]+|sk-[A-Za-z0-9_-]+/gu,'[redacted]').slice(0,4000):undefined;
        await appendFile(join(dataDir,'desktop-diagnostics.jsonl'),JSON.stringify({time:new Date().toISOString(),stage,detail})+'\n',{mode:0o600});
    };
    const resourceRoot = config.resourcesRoot ?? process.resourcesPath;
    const runtimeDir = join(root, 'dsh');
    const primaryRuntime = join(resourceRoot,'runtime/primary-runtime');
    const nodeBin = join(resourceRoot,'runtime/bin');
    const pnpm = join(primaryRuntime,'dependencies/pnpm/bin/pnpm.mjs');
    const controller = {
        isReady:()=>!!hostURL&&!!ownedHost,
        async start({ home, lease, preset }) {
            await trace('host.prepare');
            const generation = ++changeGeneration;
            const { profileDirectory } = await prepareHarnessProfile(home, 'desktop', lease, preset);
            await mountWorkspace(profileDirectory);
            const manager = new DesktopProjectManager({ profile: profileDirectory, lock: join(profileDirectory,'lock') },{ dsh: runtimeDir });
            await manager.applyRelease();
            const env = {};
            for (const name of ['PATH','Path','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','USERNAME']) if(process.env[name])env[name]=process.env[name];
            Object.assign(env,{DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',NODE_USE_SYSTEM_CA:'1',DEEPSEEK_API_KEY:lease.token,DEEPSEEK_BASE_URL:lease.modelURL});
            const host = new DesktopHostProcess(process.execPath,runtimeDir,profileDirectory,undefined,env,()=>{
                if (generation !== changeGeneration || quitting) return;
                hostURL=undefined;hostCookie=undefined;
                void showAccount('工作台连接中断，请重新进入岗位');
            },primaryRuntime,{pnpm,nodeBin});
            ownedHost=host;
            let timeout;
            try {
                await trace('host.start');
                const ready=await Promise.race([host.start(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Harness Host startup exceeded 60 seconds')),60000);})]);
                await trace('host.ready');
                const url=new URL(ready.url);
                if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw Error('Host returned an unexpected origin');
                hostCookie=await authenticateWebHost(ready.url);hostURL=ready.url;injections=ready.injections??[];
                await removeLegacyHostCookies(electronSession.defaultSession.cookies,ready.url);
                await trace('host.authenticated');
            } catch(error) { await trace('host.failed',error);await host.stop(); ownedHost=undefined;throw error; }
            finally{clearTimeout(timeout);}
        },
        async stop() {
            ++changeGeneration;
            hostURL=undefined;hostCookie=undefined;injections=[];
            if(ownedHost){await ownedHost.stop();ownedHost=undefined;}
        },
    };
    const company=await createCompanySession({serverURL:config.serverURL,dataDir,protection:{encrypt:async value=>safeStorage.encryptString(value).toString('base64'),decrypt:async value=>safeStorage.decryptString(Buffer.from(value,'base64'))},runtime:controller});
    const trusted = event => {
        if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw Error('Rejected company IPC sender');
        const url=new URL(event.senderFrame.url);
        if(url.protocol!=='dsh-app:'||!['app','company'].includes(url.hostname))throw Error('Rejected company IPC origin');
    };
    async function showAccount(message='') {
        if(window.isDestroyed())return;
        window.setTitle(productName+' · 公司账号');
        await window.loadURL('dsh-app://company/index.html'+(message?'#notice='+encodeURIComponent(message):''));
    }
    async function workspace() {
        await trace('workspace.begin');
        if(!hostURL)throw Error('工作台尚未就绪');
        const state=await company.state(), agent=state.agents.find(item=>item.id===state.activeAgentId);
        window.setTitle(productName+' · '+(agent?.displayName??'我的岗位'));
        await window.loadURL('dsh-app://app/');
        await trace('workspace.loaded');
    }
    protocol.handle('dsh-app',request=>{
        const url=new URL(request.url);
        if(url.hostname==='company')return serveWebDocument(request,join(root,'welcome')).then(response=>{response.headers.set('cache-control','no-store');return response;});
        if(url.hostname!=='app')return new Response(null,{status:404});
        if(config.integratedChrome===true&&url.pathname==='/favicon.svg')return serveWebDocument(new Request(new URL('/mark.svg',url),{method:request.method}),join(root,'assets'));
        if(url.pathname==='/'||url.pathname==='/index.html'||url.pathname.startsWith('/assets/')||['/favicon.svg','/manifest.webmanifest'].includes(url.pathname))return serveWebDocument(request,join(runtimeDir,'node_modules/@deepseek-ai/dsh-web-frontend/dist'));
        if(!hostURL||!hostCookie)return new Response(null,{status:503});
        return forwardWebRequest(request,hostURL,hostCookie);
    });
    electronSession.defaultSession.webRequest.onBeforeSendHeaders({urls:['ws://127.0.0.1/*']},(details,callback)=>{
        if(!hostURL||!hostCookie||details.webContentsId!==window.webContents.id)return callback({cancel:true});
        const expected=new URL(hostURL),actual=new URL(details.url);
        if(actual.host!==expected.host||actual.protocol!=='ws:')return callback({cancel:true});
        const headers=Object.fromEntries(Object.entries(details.requestHeaders).map(([name,value])=>[name.toLowerCase(),value]));
        if(headers.origin!=='dsh-app://app')return callback({cancel:true});
        callback({requestHeaders:{...headers,origin:expected.origin,cookie:hostCookie,'sec-fetch-site':'same-origin'}});
    });
    ipcMain.handle('dsh-desktop:boot',event=>{trusted(event);if(!hostURL)throw Error('Host unavailable');return{injections,streamBaseUrl:new URL(hostURL).origin};});
    ipcMain.handle('dsh-desktop:boot-failed',event=>{trusted(event);return showAccount('工作区加载失败，请重新进入岗位');});
    ipcMain.handle('company:call',async(event,method,input)=>{
        trusted(event);
        if(typeof method!=='string'||JSON.stringify(input??{}).length>20000)throw Error('Invalid company operation');
        try {
            let result;
            if(method==='state')result=await company.state();
            else if(method==='login')result=await company.login(input);
            else if(method==='register')result=await company.register(input);
            else if(method==='select'){result=await company.selectAgent(input.agentId,{stopActive:input.stopActive===true,refresh:input.refresh===true});await workspace();}
            else if(method==='account'){await showAccount();result={opened:true};}
            else if(method==='workspace'){await workspace();result={opened:true};}
            else if(method==='work-center')result=await company.workCenter();
            else if(method==='action')result=await company.action(input.kind,input.id,input.data);
            else if(method==='logout'){result=await company.logout();await showAccount();}
            else throw Error('Unsupported company operation');
            return{ok:true,result};
        }catch(error){return{ok:false,error:{code:error.code??'UNAVAILABLE',message:error.code?error.message:'公司操作未完成，请重试或联系管理员'}};}
    });
    ipcMain.handle('company:directory',async event=>{trusted(event);const picked=await dialog.showOpenDialog(window,{properties:['openDirectory']});return picked.canceled?null:picked.filePaths[0];});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,url)=>{const target=new URL(url);if(target.protocol!=='dsh-app:'||!['app','company'].includes(target.hostname))event.preventDefault();});
    const applicationMenu=Menu.buildFromTemplate([{label:config.integratedChrome===true?productName:'公司',submenu:[{label:'账号与岗位',click:()=>void showAccount()},{label:'工作中心',click:()=>window.webContents.send('company:navigate','work-center')},{label:'返回当前工作台',click:()=>void workspace().catch(()=>showAccount())},{type:'separator'},{label:'退出公司账号',click:()=>void company.logout().then(()=>showAccount()).catch(()=>showAccount('退出未完成，请重试'))},{label:'退出软件',click:()=>app.quit()}]},{label:'编辑',submenu:[{role:'undo',label:'撤销'},{role:'redo',label:'重做'},{type:'separator'},{role:'cut',label:'剪切'},{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'}]},{label:'查看',submenu:[{role:'reload',label:'重新加载'},{role:'toggleDevTools',label:'开发者工具'},{role:'resetZoom',label:'实际大小'},{role:'zoomIn',label:'放大'},{role:'zoomOut',label:'缩小'}]}]);
    Menu.setApplicationMenu(config.integratedChrome===true?null:applicationMenu);
    if(config.integratedChrome===true){
        window.setMenuBarVisibility(false);
        window.webContents.on('did-finish-load',()=>window.webContents.send('company:caption',window.getTitle()));
        ipcMain.handle('company:menu',(event,point)=>{trusted(event);const anchor=captionMenuPoint(point,window.webContents.getZoomFactor(),window.getContentBounds());return new Promise(resolve=>applicationMenu.popup({window,...anchor,callback:resolve}));});
        ipcMain.on('company:appearance',(event,dark)=>{try{trusted(event);}catch{return;}if(typeof dark==='boolean'&&process.platform==='win32')window.setTitleBarOverlay({color:dark?'#1c2227':'#f5f7f8',symbolColor:dark?'#e5ede8':'#24332e'});});
    }
    app.on('second-instance',()=>{if(window.isMinimized())window.restore();window.show();window.focus();});
    app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;void company.close().then(()=>app.quit(),()=>{quitting=false;void showAccount('工作台尚未确认退出，请重试');});});
    window.on('close',event=>{if(!quitting){event.preventDefault();app.quit();}});
    app.on('window-all-closed',()=>{if(!quitting)app.quit();});
    await showAccount();
}

async function mountWorkspace(profileDirectory) {
    const deployed=join(profileDirectory,'deployments/company-workspace');
    await mkdir(deployed,{recursive:true});await cp(join(root,'packages/harness-workspace'),deployed,{recursive:true});
    const modules=join(profileDirectory,'node_modules/@company');await mkdir(modules,{recursive:true});
    const link=join(modules,'harness-workspace'),existing=await lstat(link).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    if(existing){if(!existing.isSymbolicLink()||await realpath(link)!==await realpath(deployed))throw Error('Company workspace module is owned by another path');}
    else await symlink(await realpath(deployed),link,'junction');
    const path=join(profileDirectory,'package.json'),manifest=JSON.parse(await readFile(path,'utf8'));
    manifest.dependencies['@company/harness-workspace']='file:'+relative(profileDirectory,deployed).replaceAll('\\','/');
    if(!manifest.dsh.profile.bundles.includes('@company/harness-workspace'))manifest.dsh.profile.bundles.push('@company/harness-workspace');
    await writeFile(path,JSON.stringify(manifest,null,2));
}
