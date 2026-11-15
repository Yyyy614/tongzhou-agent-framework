import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/proxy|^node_options$|^global_agent/i.test(key)) delete env[key];
}
env.npm_config_proxy = 'false';
env.npm_config_https_proxy = 'false';
env.npm_config_registry = 'https://registry.npmjs.org/';
mkdirSync(resolve(root, '.tools'), {recursive:true});
const npmCli = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
function run(args) {
  const result=spawnSync(process.execPath,args,{cwd:root,env,stdio:'inherit'});
  if(result.error) throw result.error;
  if(result.status!==0) process.exit(result.status??1);
}
run([npmCli,'--userconfig='+resolve(root,'.npmrc'),'--proxy=false','--https-proxy=false','--fetch-retries=0','--fetch-timeout=30000','install','--prefix','.tools','--ignore-scripts','--no-audit','--no-fund','--package-lock=false','pnpm@11.28.5']);
run([resolve(root,'.tools/node_modules/pnpm/bin/pnpm.cjs'),'install','--frozen-lockfile','--ignore-scripts','--config.proxy=false','--config.https-proxy=false','--reporter=append-only']);
