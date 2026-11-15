import { cp, mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { companyReleaseConfig } from './company-release-config.mjs';
import { prepareCompanyRuntime } from './prepare-company-runtime.mjs';
const root=resolve(import.meta.dirname,'..');
const values={};
for(let i=2;i<process.argv.length;i+=2){const name=process.argv[i];if(!['--output','--server-url','--namespace','--version','--manifest'].includes(name)||!process.argv[i+1]||name in values)throw Error('Invalid company package arguments');values[name]=process.argv[i+1];}
if(!values['--output'])throw Error('Usage: node scripts/package-company-harness.mjs --output <new-directory> [--server-url <HTTPS-origin> --namespace <name> --version <version> --manifest <new-file>]');
const output=resolve(values['--output']);
const config=companyReleaseConfig({serverURL:values['--server-url'],dataNamespace:values['--namespace'],version:values['--version']});
const manifest=resolve(root,values['--manifest']??'.local/v04-company-release.json');
try{await access(output);throw Error('Refuse to overwrite an existing company release');}catch(error){if(error.code!=='ENOENT')throw error;}
if(values['--manifest']){try{await access(manifest);throw Error('Refuse to overwrite an existing release manifest');}catch(error){if(error.code!=='ENOENT')throw error;}}
await prepareCompanyRuntime();
const development=JSON.parse(await readFile(resolve(root,'.local/v04-app-build.json'),'utf8'));
const source=development.directory;
const electron=resolve(root,'.tools/company-build-tools/node_modules/electron/dist');
await mkdir(dirname(output),{recursive:true});
await cp(electron,output,{recursive:true});
await rename(join(output,'electron.exe'),join(output,'公司Harness.exe'));
const application=join(output,'resources/app');await mkdir(application,{recursive:true});
for(const name of ['lib','welcome','packages'])await cp(join(source,name),join(application,name),{recursive:true});
await cp(resolve(root,'.tools/harness-company-base/dsh'),join(application,'dsh'),{recursive:true});
await cp(resolve(root,'.tools/harness-desktop/resources/runtime'),join(output,'resources/runtime'),{recursive:true});
const packageJSON=JSON.parse(await readFile(join(source,'package.json'),'utf8'));packageJSON.version=config.version;
await writeFile(join(application,'package.json'),JSON.stringify(packageJSON,null,2));
await cp(resolve(root,'vendor/harness-desktop/LICENSE'),join(application,'HARNESS-LICENSE'));
await writeFile(join(application,'company.json'),JSON.stringify(config,null,2));
await writeFile(join(output,'使用说明.txt'),`公司 Agent Harness ${config.version} 测试版\r\n\r\n双击 公司Harness.exe，在同一应用内用员工账号登录、选择岗位和进入工作中心。\r\n测试服务：${config.serverURL}\r\n员工账号、岗位、插件权限和服务端私人记忆由公司服务提供；聊天历史保留在当前电脑，不自动跨电脑同步。\r\n设备数据目录：%APPDATA%/CompanyHarness/${config.dataNamespace}/公司地址摘要。旧客户端和数据保留。\r\n本包不含员工密码、设备身份、模型总Key或管理员凭证。\r\n内部测试发行尚未签名，没有启用自动更新。整个文件夹需保留，不要只复制exe。\r\n`);
async function digest(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
const metadata={...config,directory:output,executable:join(output,'公司Harness.exe'),builtAt:new Date().toISOString(),modelKeyIncluded:false,employeeIdentityIncluded:false,usesExternalLauncher:false,mainSHA256:await digest(join(application,'lib/company-main.mjs')),clientPluginSHA256:await digest(join(application,'packages/harness-workspace/lib/client.js')),upstream:JSON.parse(await readFile(resolve(root,'harness-company.lock.json'),'utf8'))};
await mkdir(dirname(manifest),{recursive:true});await writeFile(manifest,JSON.stringify(metadata,null,2));
console.log(JSON.stringify({packaged:true,version:metadata.version,directory:output,usesExternalLauncher:false}));
