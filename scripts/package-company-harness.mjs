import { cp, mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { prepareCompanyRuntime } from './prepare-company-runtime.mjs';
import { stageCompanyApplication } from './company-package-stage.mjs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const values={};
for(let i=2;i<process.argv.length;i+=2){const name=process.argv[i];if(!['--output','--server-url','--namespace','--version','--manifest','--build-manifest'].includes(name)||!process.argv[i+1]||name in values)throw Error('Invalid company package arguments');values[name]=process.argv[i+1];}
if(!values['--output'])throw Error('Usage: node scripts/package-company-harness.mjs --output <new-directory> [--server-url <HTTPS-origin> --namespace <name> --version <version> --manifest <new-file>]');
const output=resolve(values['--output']);
const manifest=resolve(root,values['--manifest']??'.local/v04-company-release.json');
try{await access(output);throw Error('Refuse to overwrite an existing company release');}catch(error){if(error.code!=='ENOENT')throw error;}
if(values['--manifest']){try{await access(manifest);throw Error('Refuse to overwrite an existing release manifest');}catch(error){if(error.code!=='ENOENT')throw error;}}
await prepareCompanyRuntime();
const development=JSON.parse(await readFile(resolve(root,values['--build-manifest']??'.local/v04-app-build.json'),'utf8'));
const source=development.directory;
const electron=resolve(root,'.tools/company-build-tools/node_modules/electron/dist');
await mkdir(dirname(output),{recursive:true});
await cp(electron,output,{recursive:true});
const executableName=development.version==='0.4.0'?'公司Harness':'同舟';
await rename(join(output,'electron.exe'),join(output,executableName+'.exe'));
const application=join(output,'resources/app');await mkdir(application,{recursive:true});
const config=await stageCompanyApplication({source,application,runtime:resolve(root,'.tools/harness-company-base/dsh'),release:{serverURL:values['--server-url'],dataNamespace:values['--namespace'],version:values['--version']??development.version}});
await cp(resolve(root,'.tools/harness-desktop/resources/runtime'),join(output,'resources/runtime'),{recursive:true,dereference:true});
await cp(resolve(root,'vendor/harness-desktop/LICENSE'),join(application,'HARNESS-LICENSE'));
await cp(resolve(root,'LICENSE'),join(output,'TONGZHOU-LICENSE'));
await cp(resolve(root,'THIRD_PARTY_NOTICES.md'),join(output,'THIRD_PARTY_NOTICES.md'));
if(config.integratedChrome){
    const require=createRequire(resolve(root,'.tools/company-installer-tools/package.json')),PE=require('pe-library'),ResEdit=require('resedit');
    const image=PE.NtExecutable.from(await readFile(join(output,executableName+'.exe')),{ignoreCert:true}),resources=PE.NtExecutableResource.from(image);
    const icons=ResEdit.Data.IconFile.from(await readFile(join(application,'assets/icon.ico'))),groups=ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
    for(const group of groups.length?groups:[{id:1,lang:1033}])ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries,group.id,group.lang,icons.icons.map(i=>i.data));
    const parts=config.version.split('.').map(Number);
    for(const version of ResEdit.Resource.VersionInfo.fromEntries(resources.entries)){
        version.setFileVersion(...parts,0,1033);version.setProductVersion(...parts,0,1033);
        version.setStringValues({lang:1033,codepage:1200},{ProductName:config.productName,FileDescription:'同舟智能工作空间',InternalName:'Tongzhou',OriginalFilename:executableName+'.exe'});version.outputToResourceEntries(resources.entries);
    }
    resources.outputResource(image);await writeFile(join(output,executableName+'.exe'),Buffer.from(image.generate()));
}
await writeFile(join(output,'使用说明.txt'),`同舟 ${config.version} Windows x64 体验版\r\n\r\n完整解压后双击 ${executableName}.exe。账号登录、岗位选择和工作中心都在 Harness 内。\r\n随包已包含桌面与 Node 运行时，无需安装开发工具。\r\n\r\n公司服务地址：${config.serverURL}\r\n此地址用于本机隔离体验，需要先启动同版本公司服务。其他电脑请先在 resources/app/company.json 中设置管理员提供的 HTTPS serverURL，再用公司员工账号登录。发行包不提供公开试用账号。\r\n员工账号、岗位、插件权限和服务端私人记忆由公司服务提供；聊天历史保留在当前电脑。\r\n设备数据目录：%APPDATA%/CompanyHarness/${config.dataNamespace}/公司地址摘要，独立于旧客户端。\r\n发行包不含员工密码、设备身份、模型Key、管理员凭证或本机数据库。\r\n预览发行尚未签名，未启用自动更新。请保留整个文件夹，不要只复制exe。\r\n开源代码与部署说明：https://github.com/Yyyy614/tongzhou-agent-framework\r\n`);
async function digest(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
const metadata={...config,directory:output,executable:join(output,executableName+'.exe'),executableName,builtAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),modelKeyIncluded:false,employeeIdentityIncluded:false,usesExternalLauncher:false,mainSHA256:await digest(join(application,'lib/company-main.mjs')),clientPluginSHA256:await digest(join(application,'packages/harness-workspace/lib/client.js')),upstream:JSON.parse(await readFile(resolve(root,'harness-company.lock.json'),'utf8'))};
await mkdir(dirname(manifest),{recursive:true});await writeFile(manifest,JSON.stringify(metadata,null,2));
console.log(JSON.stringify({packaged:true,version:metadata.version,directory:output,usesExternalLauncher:false}));
