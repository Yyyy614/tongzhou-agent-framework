import{cp,readFile,mkdir,access,rename,symlink,writeFile,realpath}from'node:fs/promises';
import{resolve,join}from'node:path';
import{createRequire}from'node:module';

// A branded local testing executable; all runtime copies stay outside deployed clients.
const root=resolve(import.meta.dirname,'..'),base=resolve(root,'.local/ui-integrated');
const build=JSON.parse(await readFile(join(base,'build.json'),'utf8'));
if(build.directory!==join(base,'app')||build.version!=='0.5.1')throw Error('Build the studio candidate first');
const output=join(base,'desktop-'+build.version);
const electron=resolve(root,'.tools/company-build-tools/node_modules/electron/dist'),executable=join(output,'同舟.exe');
if(process.argv.includes('--resume')){
    if(await realpath(join(output,'resources/app'))!==await realpath(build.directory))throw Error('Unexpected testing runtime');
}else{
    try{await access(output);throw Error('Refuse to overwrite an existing desktop runtime');}catch(e){if(e.code!=='ENOENT')throw e;}
    await cp(electron,output,{recursive:true});await rename(join(output,'electron.exe'),executable);
    await mkdir(join(output,'resources'),{recursive:true});await symlink(build.directory,join(output,'resources/app'),'junction');
}
const require=createRequire(resolve(root,'.tools/company-installer-tools/package.json')),PE=require('pe-library'),ResEdit=require('resedit');
// Read the shared vendor file; change only our new, unsigned testing copy.
const image=PE.NtExecutable.from(await readFile(join(electron,'electron.exe')),{ignoreCert:true}),resources=PE.NtExecutableResource.from(image);
const icons=ResEdit.Data.IconFile.from(await readFile(join(root,'packages/company-ui/assets/icon.ico')));
const groups=ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
for(const group of groups.length?groups:[{id:1,lang:1033}])ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries,group.id,group.lang,icons.icons.map(i=>i.data));
for(const version of ResEdit.Resource.VersionInfo.fromEntries(resources.entries)){
    version.setFileVersion(0,5,1,0,1033);version.setProductVersion(0,5,1,0,1033);
    version.setStringValues({lang:1033,codepage:1200},{ProductName:'同舟',FileDescription:'同舟智能工作空间',InternalName:'Tongzhou',OriginalFilename:'同舟.exe'});version.outputToResourceEntries(resources.entries);
}
resources.outputResource(image);await writeFile(executable,Buffer.from(image.generate()));
await writeFile(join(base,'desktop.json'),JSON.stringify({executable,version:build.version,mode:'local-isolated',workspaceRequired:true},null,2));
console.log(JSON.stringify({built:true,version:build.version,executable,embeddedIcon:true}));
