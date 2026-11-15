import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const local=resolve(root,'.local');mkdirSync(local,{recursive:true});
const cluster=resolve(local,'postgres');const configPath=resolve(local,'database.json');
const config=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{host:'127.0.0.1',port:55437,user:'framework_dev',password:randomBytes(24).toString('hex'),database:'postgres'};
writeFileSync(configPath,JSON.stringify(config,null,2),{mode:0o600});
const pwFile=resolve(local,'postgres-password');writeFileSync(pwFile,config.password,{mode:0o600});
function execute(command,args,allowFailure=false){const fd=openSync(resolve(local,'postgres-setup.log'),'a');const r=spawnSync(command,args,{windowsHide:true,env:process.env,stdio:['ignore',fd,fd]});closeSync(fd);if(r.error)throw r.error;if(r.status&&!allowFailure)throw new Error(command+' failed; see .local/postgres-setup.log');return r;}
if(!existsSync(resolve(cluster,'PG_VERSION'))){execute('initdb',['-D',cluster,'-U',config.user,'--pwfile='+pwFile,'--auth-host=scram-sha-256','--auth-local=scram-sha-256','--encoding=UTF8','--locale=C']);}
const status=execute('pg_ctl',['status','-D',cluster],true);
if(status.status!==0)execute('pg_ctl',['start','-D',cluster,'-l',resolve(local,'postgres.log'),'-o',`-h 127.0.0.1 -p ${config.port}`,'-w','-t','30']);
console.log(JSON.stringify({ready:true,host:config.host,port:config.port,cluster,configuration:'credentials saved under ignored .local/database.json'}));
