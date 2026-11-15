import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const source=resolve(root,'.tools/harness-company-source');
const commit='e8f7b93a344964de3dca1ace9e72b6e4d6de87cb';
if(execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim()!==commit)throw Error('Harness source commit differs from the company baseline');
const files=['host-process.ts','node-environment.ts','web-document.ts','project-manager.ts','runtime-tree.ts','core-package-set.ts','release.ts','host-protocol.ts','paths.ts'];
const target=resolve(root,'vendor/harness-desktop');await mkdir(target,{recursive:true});
const hashes={};for(const file of files){const bytes=await readFile(resolve(source,'apps/desktop/src',file));hashes[file]=createHash('sha256').update(bytes).digest('hex');await writeFile(resolve(target,file),bytes);}
await cp(resolve(source,'LICENSE'),resolve(target,'LICENSE'));
await writeFile(resolve(root,'harness-company.lock.json'),JSON.stringify({upstreamVersion:'0.2.2-rc.2',upstreamCommit:commit,electronVersion:'44.7.0',modules:hashes},null,2)+'\n');
console.log(JSON.stringify({prepared:true,commit,modules:files.length}));
