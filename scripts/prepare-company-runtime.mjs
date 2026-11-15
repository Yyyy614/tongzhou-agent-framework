import { readFile, mkdir, rename, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=resolve(import.meta.dirname,'..');
async function hash(path){const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest('hex');}
/** Verify the pinned published runtime; only a missing cache is extracted into a fresh directory. */
export async function prepareCompanyRuntime(){
    const pin=JSON.parse(await readFile(join(root,'harness-desktop.lock.json'),'utf8'));
    const archive=join(root,'.tools/harness-desktop/resources/app.asar');
    if(await hash(archive)!==pin.asarSHA256)throw Error('Harness application archive differs from the reviewed release');
    const asar=await import('../.tools/company-build-tools/node_modules/@electron/asar/lib/asar.js');
    const destination=join(root,'.tools/harness-company-base');
    try{await stat(join(destination,'package.json'));}
    catch(error){
        if(error.code!=='ENOENT')throw error;
        const temporary=join(root,'.tools/company-runtime-'+randomUUID());await mkdir(temporary);
        asar.extractAll(archive,temporary);
        await rename(temporary,destination);
    }
    const runtime=join(destination,'dsh'),recorded=asar.extractFile(archive,'dsh/desktop-runtime.json');
    if(!recorded.equals(await readFile(join(runtime,'desktop-runtime.json'))))throw Error('Runtime inventory differs from the pinned archive');
    const inventory=JSON.parse(recorded.toString('utf8'));
    if(inventory.schemaVersion!==1||inventory.release?.version!==pin.version||!Array.isArray(inventory.files)||inventory.files.length<100)throw Error('Runtime inventory is missing or mismatched');
    let cursor=0;
    await Promise.all(Array.from({length:8},async()=>{
        for(;;){
            const index=cursor++;if(index>=inventory.files.length)return;const entry=inventory.files[index];
            if(typeof entry.path!=='string'||entry.path.includes('\\')||entry.path.split('/').some(piece=>!piece||piece==='..'||piece==='.')||isAbsolute(entry.path))throw Error('Unsafe runtime inventory path');
            const target=resolve(runtime,entry.path),part=relative(runtime,target);
            if(part==='..'||part.startsWith('..'+sep)||isAbsolute(part))throw Error('Runtime inventory escaped the cache');
            const metadata=await stat(target);
            if(metadata.size!==entry.bytes||await hash(target)!==entry.sha256)throw Error('Runtime file differs from its recorded bytes: '+entry.path);
        }
    }));
    const evidence={verifiedAt:new Date().toISOString(),version:pin.version,sourceASARSHA256:pin.asarSHA256,files:inventory.files.length,verified:true};
    await writeFile(join(root,'.local/v04-runtime-integrity.json'),JSON.stringify(evidence,null,2));
    return{directory:destination,...evidence};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(await prepareCompanyRuntime()));
