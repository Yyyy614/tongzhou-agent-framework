import { test, expect } from 'vitest';
import { mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
test('the desktop shell receives a private handoff without opening a browser and reuses the employee service', async () => {
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/desktop-launch-'));
    await cp('client', resolve(root, 'client'), { recursive: true });
    await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
    await writeFile(resolve(root, 'company.json'), JSON.stringify({ serverURL: 'http://127.0.0.1:4317' }));
    const data = resolve(root, 'device'), handoff = resolve(root, 'shell.json');
    const args = [resolve(root, 'client/start.mjs'), '--no-open', '--data-dir', data, '--handoff-file', handoff];
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: 'ignore' });
    try {
        await expect.poll(async () => { try { return !!JSON.parse(await readFile(handoff, 'utf8')).origin; } catch { return false; } }, { timeout: 5000 }).toBe(true);
        const first = JSON.parse(await readFile(handoff, 'utf8'));
        const secondFile = resolve(root, 'second.json');
        const second = spawn(process.execPath, [...args.slice(0, -1), secondFile], { windowsHide: true, stdio: 'ignore' });
        const exited = new Promise<void>(r => second.once('exit', () => r()));
        await expect.poll(async () => { try { return JSON.parse(await readFile(secondFile, 'utf8')).origin; } catch { return null; } }).toBe(first.origin);
        await exited;
        const response = await fetch(first.origin + '/api/shutdown', { method: 'POST', headers: { origin: first.origin, 'x-client-session': first.session }, body: '{}' });
        expect(response.status).toBe(200);
    } finally { child.kill(); }
});
