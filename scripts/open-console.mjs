import {resolve} from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {parseEnv} from 'node:util';
import {createFramework} from '../dist/index.js';
import {ConsoleSessions} from '../dist/console-auth.js';
try{const settings=parseEnv(await readFile('.env','utf8'));for(const key of ['PORT','FRAMEWORK_ROOT','DATABASE_URL'])if(process.env[key]===undefined&&settings[key]!==undefined)process.env[key]=settings[key];}catch(error){if(error.code!=='ENOENT')throw error;}
const principalId=process.argv.slice(2).find(a=>!a.startsWith('--'))??'admin';
const origin=`http://127.0.0.1:${process.env.PORT??4317}`;
const health=await fetch(origin+'/health',{signal:AbortSignal.timeout(5000)}).catch(()=>null);
if(!health?.ok)throw new Error('Start the framework service before opening the console');
const host=await createFramework({root:resolve(process.env.FRAMEWORK_ROOT??'.local/host')});
try{
 const code=await new ConsoleSessions(host).issueCode(principalId);await mkdir('.local',{recursive:true});await writeFile('.local/console-entry.json',JSON.stringify({code,origin,expiresAt:new Date(Date.now()+600000).toISOString()}));
 if(!process.argv.includes('--no-open')){
  const url=origin+'/#entry='+encodeURIComponent(code);const env={FRAMEWORK_CONSOLE_URL:url};for(const key of ['PATH','Path','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
  if(process.platform==='win32'){const result=spawnSync('pwsh.exe',['-NoProfile','-Command','Start-Process -FilePath $env:FRAMEWORK_CONSOLE_URL'],{env,windowsHide:true,stdio:'ignore'});if(result.status!==0)throw new Error('Browser could not be opened');}
  else throw new Error('Use the generated local entry file with your browser on this platform');
 }
 console.log(JSON.stringify({status:'ready',url:origin,principalId,entry:'One-time entry saved under ignored .local; credentials are not printed.'}));
}finally{await host.close();}
