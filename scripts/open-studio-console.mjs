import{resolve}from'node:path';
import{readFile}from'node:fs/promises';
import{spawnSync}from'node:child_process';
import{createFramework}from'../dist/index.js';
import{ConsoleSessions}from'../dist/console-auth.js';

const project=resolve(import.meta.dirname,'..'),directory=resolve(project,'.local/ui-integrated');
const runtime=JSON.parse(await readFile(resolve(directory,'runtime.json'),'utf8'));
if(runtime.url!=='http://127.0.0.1:4917'||resolve(runtime.root)!==resolve(directory,'host'))throw Error('Unexpected studio environment');
const response=await fetch(runtime.url+'/health',{signal:AbortSignal.timeout(5000)});
if(!response.ok)throw Error('Start the isolated studio service first');
const host=await createFramework({root:resolve(directory,'host')});
try{
    const code=await new ConsoleSessions(host).issueCode('studio-ui-admin');
    const env={...process.env,STUDIO_CONSOLE_URL:runtime.url+'/#entry='+encodeURIComponent(code)};
    const opened=spawnSync('pwsh.exe',['-NoProfile','-Command','Start-Process -FilePath $env:STUDIO_CONSOLE_URL'],{env,windowsHide:true,stdio:'ignore'});
    if(opened.status!==0)throw Error('Could not open the studio console');
    console.log('Isolated studio console opened.');
}finally{await host.close();}
