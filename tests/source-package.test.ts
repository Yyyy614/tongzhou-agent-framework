import{test,expect}from'vitest';
import{mkdtemp,mkdir,writeFile,readFile,readdir}from'node:fs/promises';
import{resolve,join}from'node:path';import{execFileSync,spawnSync}from'node:child_process';import{createHash,randomBytes}from'node:crypto';
const command=resolve('scripts/source-package.mjs');
async function fixture(){
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data/source-export-')),repo=join(root,'repo'),output=join(root,'delivery');await mkdir(repo);
    const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8',windowsHide:true});
    git('init','-q','--initial-branch=main');git('config','user.name','Export fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
    await writeFile(join(repo,'.gitignore'),'.env\n');await writeFile(join(repo,'README.md'),'# Fixture\n');await writeFile(join(repo,'.env'),'NOT_A_REAL_CREDENTIAL=private\n');git('add','.');git('commit','-qm','fixture');
    return{repo,output,git,run:()=>spawnSync(process.execPath,[command,'--repo',repo,'--output',output],{encoding:'utf8',windowsHide:true})};
}
function zipNames(bytes:Buffer){const names:string[]=[];for(let i=0;i+46<=bytes.length;i++){if(bytes.readUInt32LE(i)===0x02014b50){const length=bytes.readUInt16LE(i+28);names.push(bytes.subarray(i+46,i+46+length).toString());i+=45+length+bytes.readUInt16LE(i+30)+bytes.readUInt16LE(i+32);}}return names;}
test('source export contains committed source, hash and file manifest, excluding local credentials',async()=>{
    const f=await fixture(),run=f.run();expect(run.status,run.stderr).toBe(0);const report=JSON.parse(run.stdout);const manifest=JSON.parse(await readFile(report.manifest,'utf8'));const zip=await readFile(report.archive);
    expect(manifest.commit).toBe(f.git('rev-parse','HEAD').trim());expect(manifest.sha256).toBe(createHash('sha256').update(zip).digest('hex'));expect(manifest.files.map((x:any)=>x.path)).toContain('README.md');
    expect(zipNames(zip)).toContain('tongzhou-agent-framework/README.md');expect(zipNames(zip).some(n=>n.endsWith('/.env'))).toBe(false);
});
test('source export rejects dirty source instead of shipping an outdated commit',async()=>{const f=await fixture();await writeFile(join(f.repo,'README.md'),'uncommitted');const run=f.run();expect(run.status).not.toBe(0);expect(run.stderr).toContain('uncommitted');});
test('source export blocks tracked private files and token-like literals without printing their values',async()=>{
    const f=await fixture();f.git('add','-f','.env');f.git('commit','-qm','unsafe fixture');let run=f.run();expect(run.status).not.toBe(0);expect(run.stderr).toContain('.env');
    f.git('rm','--cached','.env');const secret='sk-'+randomBytes(24).toString('hex');await writeFile(join(f.repo,'bad-config.json'),JSON.stringify({key:secret}));f.git('add','.');f.git('commit','-qm','token fixture');run=f.run();expect(run.status).not.toBe(0);expect(run.stderr).toContain('model-key');expect(run.stderr).not.toContain(secret);
    expect(await readdir(f.output).catch(()=>[])).toHaveLength(0);
});
