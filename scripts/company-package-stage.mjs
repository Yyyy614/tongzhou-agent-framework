import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {companyReleaseConfig} from './company-release-config.mjs';

/** Copy reviewed application assets, never a development device directory or its configuration. */
export async function stageCompanyApplication({source,application,runtime,release}){
    const sourceConfig=JSON.parse(await readFile(join(source,'company.json'),'utf8'));
    const packageJSON=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
    const config=companyReleaseConfig({...release,productName:sourceConfig.productName,integratedChrome:sourceConfig.integratedChrome});
    if(sourceConfig.version!==config.version||packageJSON.version!==config.version)throw Error('Reviewed application version differs from release version');
    await mkdir(application,{recursive:true});
    for(const name of ['lib','welcome','packages',...(config.integratedChrome?['assets']:[])])await cp(join(source,name),join(application,name),{recursive:true,dereference:true});
    await cp(runtime,join(application,'dsh'),{recursive:true,dereference:true});
    await writeFile(join(application,'package.json'),JSON.stringify(packageJSON,null,2));
    await writeFile(join(application,'company.json'),JSON.stringify(config,null,2));
    return config;
}
