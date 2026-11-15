import{execFileSync}from'node:child_process';import{readFile,mkdir,access,writeFile,rename}from'node:fs/promises';import{resolve,join,basename}from'node:path';import{createHash}from'node:crypto';
import{sourceIssues}from'./source-safety.mjs';
const options={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(!['--repo','--output'].includes(key)||!process.argv[i+1]||key in options)throw Error('Usage: node scripts/source-package.mjs [--repo <directory>] [--output <new-output-directory>]');options[key]=process.argv[i+1];}
const root=resolve(options['--repo']??resolve(import.meta.dirname,'..')),output=resolve(options['--output']??join(root,'artifacts'));
const git=(...args)=>execFileSync('git',args,{cwd:root,windowsHide:true,maxBuffer:32*1024*1024});
try{
    const commit=git('rev-parse','HEAD').toString().trim();
    if(git('status','--porcelain','--untracked-files=normal').toString().trim())throw Error('Refusing export: uncommitted source changes exist');
    const files=[],issues=[];
    for(const record of git('ls-tree','-rz','--full-tree','HEAD').toString().split('\0').filter(Boolean)){
        const split=record.indexOf('\t'),path=record.slice(split+1),metadata=record.slice(0,split).split(' ');
        if(metadata[0]==='120000')issues.push({path,rule:'symbolic-link'});
        const bytes=git('show','HEAD:'+path);issues.push(...sourceIssues(path,bytes));files.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    }
    if(issues.length)throw Error('Source publication rejected: '+JSON.stringify(issues));
    const stem='tongzhou-source-'+commit.slice(0,12),archive=join(output,stem+'.zip'),manifest=join(output,stem+'.manifest.json');
    for(const path of[archive,manifest]){try{await access(path);throw Error('Refuse to overwrite an existing source export');}catch(e){if(e.code!=='ENOENT')throw e;}}
    await mkdir(output,{recursive:true});
    git('archive','--format=zip','--prefix=tongzhou-agent-framework/','--output='+archive+'.tmp',commit);await rename(archive+'.tmp',archive);
    const zip=await readFile(archive);await writeFile(manifest,JSON.stringify({format:1,commit,archive:basename(archive),sha256:createHash('sha256').update(zip).digest('hex'),files},null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({archive,manifest,commit,files:files.length,sha256:createHash('sha256').update(zip).digest('hex')}));
}catch(error){console.error(error.message);process.exitCode=1;}
