import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { FrameworkError } from '../errors.js';
import { redact } from '../persistence.js';
export class PluginWorker {
    private child: ChildProcessWithoutNullStreams;
    private next = 0;
    private pending = new Map<string, {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
    }>();
    constructor(cwd: string, private services: (method: string, params: any) => Promise<unknown>) {
        const env: NodeJS.ProcessEnv = {};
        for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP'])
            if (process.env[key])
                env[key] = process.env[key];
        this.child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child.stderr.on('data', () => { });
        createInterface({ input: this.child.stdout }).on('line', line => { void this.receive(line); });
        const stopped = () => {
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(new FrameworkError('PLUGIN_EXITED', 'Plugin worker stopped'));
            }
            this.pending.clear();
        };
        this.child.on('error', stopped);
        this.child.on('exit', stopped);
    }
    private async receive(line: string) {
        let message: any;
        try {
            message = JSON.parse(line);
        }
        catch {
            return;
        }
        if (message.method) {
            try {
                this.send({ jsonrpc: '2.0', id: message.id, result: await this.services(message.method, message.params) });
            }
            catch (e) {
                const error = e as Error & {
                    code?: string;
                };
                this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: redact(error.message), data: { code: error.code ?? 'HOST_ERROR' } } });
            }
            return;
        }
        const p = this.pending.get(message.id);
        if (!p)
            return;
        clearTimeout(p.timer);
        this.pending.delete(message.id);
        if (message.error)
            p.reject(new FrameworkError(message.error.data?.code ?? 'PLUGIN_ERROR', redact(message.error.message)));
        else
            p.resolve(message.result);
    }
    private send(value: unknown) {
        if (this.child.stdin.writable)
            this.child.stdin.write(JSON.stringify(value) + '\n');
    }
    call(method: string, params: unknown, timeout = 15000): Promise<any> { const id = 'host-' + (++this.next); return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new FrameworkError('RESULT_UNKNOWN', 'Plugin response timed out')); }, timeout); this.pending.set(id, { resolve, reject, timer }); this.send({ jsonrpc: '2.0', id, method, params }); }); }
    async close() { await this.call('plugin.shutdown', {}, 1000).catch(() => { }); this.child.stdin.end(); this.child.kill(); }
}
