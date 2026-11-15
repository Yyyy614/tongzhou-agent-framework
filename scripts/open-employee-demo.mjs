import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(await readFile(resolve(project, '.local/employee-client-release.json'), 'utf8'));
// Local verification fixture only; never included in the employee release.
const child = spawn(resolve(release.directory, 'runtime/node.exe'), [resolve(release.directory, 'client/start.mjs'), '--data-dir', resolve(project, '.local/employee-devices/staff-a')], { windowsHide: true, stdio: 'inherit' });
child.on('error', () => { console.error('本机员工体验入口未准备，请先构建员工客户端。'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
