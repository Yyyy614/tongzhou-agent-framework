import{readFile,writeFile,mkdir,rename,unlink}from'node:fs/promises';
import{resolve,dirname}from'node:path';
import{homedir}from'node:os';
import{createHash,randomUUID}from'node:crypto';
import{windowsProtection}from'../client/credential-store.mjs';

const options=new Map(),words=[];for(let i=2;i<process.argv.length;i++){const value=process.argv[i];if(value.startsWith('--')){if(['--json','--wait','--password-stdin'].includes(value))options.set(value,true);else{const next=process.argv[++i];if(!next||next.startsWith('--'))throw Error('MISSING_OPTION_VALUE');options.set(value,next);}}else words.push(value);}
const config=resolve(options.get('--config')??resolve(homedir(),'.company-agent','cli.json'));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const required=name=>{const value=options.get(name);if(typeof value!=='string'||!value.trim())throw Error('REQUIRED_'+name.slice(2).toUpperCase());return value;};
async function encode(value){return JSON.stringify(process.platform==='win32'?{protected:await windowsProtection.encrypt(JSON.stringify(value))}:{private:value});}
async function decode(path){const value=JSON.parse(await readFile(path,'utf8'));if(value.protected)return JSON.parse(await windowsProtection.decrypt(value.protected));if(process.platform==='win32')throw Error('UNPROTECTED_IDENTITY');return value.private;}
async function save(path,value){await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,await encode(value),{flag:'wx',mode:0o600});await rename(temp,path);}
function serverURL(value){const url=new URL(value);if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('HTTPS_SERVER_REQUIRED');return url.href.replace(/\/$/u,'');}
async function request(origin,path,method='GET',body,token){
    let response;try{response=await fetch(origin+path,{method,redirect:'error',headers:{...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});}catch{throw Error(method==='GET'?'NETWORK_UNAVAILABLE':'RESULT_UNKNOWN_USE_SAME_KEY');}
    let result;try{result=await response.json();}catch{throw Error(method==='GET'?'INVALID_OUTPUT':'RESULT_UNKNOWN_USE_SAME_KEY');}if(!response.ok)throw Error(result.error?.code??'REQUEST_FAILED');return result;
}
async function password(){
    if(options.has('--password-file'))return(await readFile(required('--password-file'),'utf8')).replace(/\r?\n$/u,'');
    if(options.has('--password-stdin')){let value='';process.stdin.setEncoding('utf8');for await(const chunk of process.stdin){value+=chunk;if(value.length>4096)throw Error('PASSWORD_TOO_LONG');}return value.replace(/\r?\n$/u,'');}
    if(!process.stdin.isTTY)throw Error('USE_PASSWORD_STDIN_OR_FILE');
    process.stdout.write('公司账号密码：');const previous=process.stdin.isRaw;process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();
    try{return await new Promise((ok,no)=>{let value='';const onData=chunk=>{for(const char of chunk){if(char==='\r'||char==='\n'){process.stdin.off('data',onData);process.stdout.write('\n');ok(value);return;}if(char==='\u0003'){process.stdin.off('data',onData);no(Error('LOGIN_CANCELLED'));return;}if(char==='\u007f'||char==='\b'){value=Array.from(value).slice(0,-1).join('');process.stdout.write('\b \b');}else if(value.length<4096){value+=char;process.stdout.write('*');}}};process.stdin.on('data',onData);});}finally{process.stdin.setRawMode(previous??false);process.stdin.pause();}
}
async function mutate(identity,path,input,prepare){
    const key=required('--key'),fingerprint=hash({path,input}),journal=resolve(dirname(config),'requests',hash([identity.serverURL,identity.username,words,key])+'.json');await mkdir(dirname(journal),{recursive:true,mode:0o700});let record;
    try{record=await decode(journal);}catch(error){if(error.code!=='ENOENT')throw error;const body=await prepare();record={fingerprint,body};try{await writeFile(journal,await encode(record),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;record=await decode(journal);}}
    if(record.fingerprint!==fingerprint)throw Error('KEY_REUSED_WITH_CHANGED_INPUT');return request(identity.serverURL,path,'POST',record.body,identity.token);
}
try{
    const command=words[0];
    if(command==='login'){
        const origin=serverURL(required('--server')),username=required('--username');const result=await request(origin,'/v1/employee/login','POST',{username,password:await password(),deviceName:'Company Agent CLI'});if(!result.accessToken)throw Error('INVALID_LOGIN_RECEIPT');await save(config,{serverURL:origin,username,token:result.accessToken,deviceId:result.deviceId});console.log(JSON.stringify({ok:true,username,serverURL:origin}));
    }else if(command==='agents'||command==='work'||command==='logout'){
        const identity=await decode(config);serverURL(identity.serverURL);if(options.has('--server')&&serverURL(required('--server'))!==identity.serverURL)throw Error('LOGIN_REQUIRED_FOR_DIFFERENT_SERVER');
        if(command==='logout'){await request(identity.serverURL,'/v1/employee/logout','POST',{},identity.token);await unlink(config);console.log('已退出当前CLI设备。');}
        else if(command==='agents'){const agents=await request(identity.serverURL,'/v1/agents','GET',undefined,identity.token);console.log(JSON.stringify(agents.map(a=>({id:a.id,name:a.displayName??a.id,active:a.active})),null,2));}
        else{
            const action=words[1];let result;
            if(action==='get'||action==='history')result=await request(identity.serverURL,'/v1/work/'+required('--id')+(action==='history'?'/history':''),'GET',undefined,identity.token);
            else if(action==='create'){const input={title:options.get('--title')??required('--text').slice(0,80),assignments:[{agentId:required('--agent'),prompt:required('--text')}]};result=await mutate(identity,'/v1/work',input,async()=>({...input,idempotencyKey:'cli:'+required('--key')}));}
            else if(['stop','wait','resume','reconcile'].includes(action)){
                const id=required('--id'),path='/v1/work/'+id+(action==='reconcile'?'/reconcile':'/control');
                const input=action==='reconcile'?JSON.parse(await readFile(required('--request-file'),'utf8')):{action,reason:required('--reason'),...(action==='wait'?{waitReason:'human_decision',question:options.get('--text')??required('--reason')}:{}) ,...(action==='resume'?{assignments:[{agentId:required('--agent'),prompt:required('--text')}]}:{})};
                result=await mutate(identity,path,input,async()=>({...input,revision:input.revision??(await request(identity.serverURL,'/v1/work/'+id,'GET',undefined,identity.token)).revision,idempotencyKey:'cli:'+required('--key')}));
            }else throw Error('USAGE_WORK_CREATE_GET_STOP_WAIT_RESUME_RECONCILE_HISTORY');
            if(options.has('--wait')&&action!=='history'){const id=result.workId??result.id??required('--id'),deadline=Date.now()+150000;do{result=await request(identity.serverURL,'/v1/work/'+id,'GET',undefined,identity.token);if(!['queued','running','stop_requested'].includes(result.state))break;await new Promise(r=>setTimeout(r,500));}while(Date.now()<deadline);}
            console.log(JSON.stringify(result,null,2));if(['needs_attention','reconciliation_required'].includes(result.state))process.exitCode=2;
        }
    }else console.log('公司Agent CLI\nlogin --server HTTPS地址 --username 员工账号\nagents\nwork create --agent 岗位 --text 要求 --key 唯一请求标识 [--wait]\nwork get|history --id 工作编号\nwork stop|wait|resume --id 工作编号 --reason 原因 --key 标识 [--agent 岗位 --text 新要求]\nwork reconcile --id 工作编号 --request-file 核实文件 --key 标识\n--config 指定独立账号配置文件；Windows凭证使用DPAPI保护。');
}catch(error){console.error('CLI：'+(String(error.message).match(/^[A-Z0-9_-]+$/u)?error.message:'REQUEST_FAILED'));process.exitCode=1;}
