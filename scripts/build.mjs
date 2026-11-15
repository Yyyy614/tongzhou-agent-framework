import { spawnSync } from 'node:child_process';
import { copyFileSync,mkdirSync } from 'node:fs';
const result=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.json'],{stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);
mkdirSync('dist/plugins',{recursive:true});copyFileSync('src/plugins/worker.mjs','dist/plugins/worker.mjs');
copyFileSync('client/web/result-view.mjs','web/result-view.mjs');
const bundle = spawnSync(process.execPath, ['scripts/build-harness-bundle.mjs'], {stdio:'inherit',windowsHide:true});
if(bundle.error) throw bundle.error; if(bundle.status !== 0) process.exit(bundle.status ?? 1);
