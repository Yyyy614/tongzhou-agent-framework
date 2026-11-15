import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createFramework } from './index.js';
import { createServer } from './server.js';
import { HarnessRuntime } from './runtime.js';
import { bootstrap } from './bootstrap.js';
import { TaskQueue } from './tasks.js';
import { redact } from './persistence.js';
import { HostLease } from './host-lease.js';
import type { FastifyInstance } from 'fastify';
const command = process.argv[2] ?? 'serve';
const origin = `http://127.0.0.1:${process.env.PORT ?? 4317}`;
let cleanup: (() => Promise<void>) | undefined;
async function request(path: string, method = 'GET', body?: unknown, actor = 'alice') {
    const access = JSON.parse(await readFile('.local/access.json', 'utf8'));
    const response = await fetch(origin + path, { method, headers: { authorization: 'Bearer ' + access[actor], 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(150000) });
    const result = await response.json();
    if (!response.ok)
        throw Object.assign(new Error(result.error?.message ?? 'HTTP request failed'), { code: result.error?.code ?? response.status });
    return result;
}
try {
    if (command === 'serve') {
        const host = await createFramework({ root: resolve(process.env.FRAMEWORK_ROOT ?? '.local/host'),entries:process.env.ENABLE_ENTRY_CONNECTORS==='1',publicOrigin:process.env.PUBLIC_ORIGIN });
        let lease: HostLease | undefined, app: FastifyInstance | undefined, runtime: HarnessRuntime | undefined, queue: TaskQueue | undefined;
        cleanup = async () => { await host.entries?.close();await host.assistant?.close(); await runtime?.close(); await queue?.close(); await app?.close(); await lease?.close(); await host.close(); };
        lease = await HostLease.acquire(host.db);
        await bootstrap(host);
        app = await createServer(host, { trustedProxyIP: process.env.TRUSTED_PROXY_IP,publicBasePath:process.env.PUBLIC_BASE_PATH });
        let upstream = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/u, '');
        if (upstream === 'https://api.deepseek.com')
            upstream += '/anthropic';
        const concurrency = Number(process.env.MAX_CONCURRENT_AGENTS ?? 3);
        runtime = new HarnessRuntime(app, host, { apiKey: process.env.DEEPSEEK_API_KEY ?? '', upstreamURL: upstream, model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', publicOrigin: process.env.PUBLIC_ORIGIN, maxConcurrentRuns: concurrency });
        queue = new TaskQueue(host, runtime, concurrency);
        runtime.enableDelegation(queue);
        await queue.open();
        queue.registerRoutes(app);
        await runtime.recoverInterrupted();
        await queue.recoverInterrupted();
        await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 4317) });
        await queue.startWorker();
        host.assistant?.start();
        await host.entries?.start();
        console.log(JSON.stringify({ status: 'ready', url: app.listeningOrigin, credentialsFile: resolve('.local/access.json') }));
        let closing = false;
        const shutdown = async () => {
            if (closing)
                return;
            closing = true;
            await cleanup?.();
        };
        process.on('SIGINT', () => void shutdown());
        process.on('SIGTERM', () => void shutdown());
    }
    else if (command === 'harness-smoke') {
        const key = 'live-' + Date.now();
        const result = await request('/v1/runs', 'POST', { agentId: 'worker-a', prompt: '请调用 normalize 工具，把字符串 "  Harness   已接通  " 的多余空格去掉。然后读取你自己的 INDEX 笔记，用 report_record 记录工具验证结果。最终回复只给出规范化后的字符串。不要修改笔记。', idempotencyKey: key });
        const logs = await request('/v1/agents/worker-a/logs');
        const usage = await request('/v1/agents/worker-a/usage');
        const tool = logs.find((l: any) => l.type === 'tool.succeeded' && l.data.runId === result.id);
        const report = logs.find((l: any) => l.type === 'report.recorded' && l.data.runId === result.id);
        const records = usage.records.filter((u: any) => u.runId === result.id);
        const memoryRead = logs.find((l: any) => l.type === 'runtime.tool_succeeded' && l.data.runId === result.id && l.data.toolName === 'memory_read');
        if (result.state !== 'succeeded' || !tool || !report || !memoryRead || !result.output.includes('Harness 已接通'))
            throw new Error('Live smoke did not satisfy tool/report/output assertions');
        if (!records.length || records.some((r: any) => r.measurement !== 'provider'))
            throw new Error('Live smoke is missing provider usage');
        const runUsage = { requests: records.length, inputTokens: records.reduce((n: number, r: any) => n + r.inputTokens, 0), outputTokens: records.reduce((n: number, r: any) => n + r.outputTokens, 0), records };
        const evidence = { testedAt: new Date().toISOString(), mode: 'live-deepseek-real-harness', runId: result.id, state: result.state, output: result.output, toolReceipt: tool.id, memoryReadReceipt: memoryRead.id, reportReceipt: report.id, usage: runUsage };
        await writeFile('.local/live-smoke.json', JSON.stringify(evidence, null, 2));
        console.log(JSON.stringify({ mode: evidence.mode, runId: result.id, state: result.state, output: result.output, modelRequests: runUsage.requests, inputTokens: runUsage.inputTokens, outputTokens: runUsage.outputTokens, evidence: resolve('.local/live-smoke.json') }));
    }
    else if (command === 'smoke' || command === 'demo') {
        const results = await Promise.all(['alice', 'bob'].map((actor, i) => request('/v1/invoke', 'POST', { agentId: i ? 'worker-b' : 'worker-a', toolRef: '@example/conformance:text.normalize', input: { text: '  framework   works  ' }, idempotencyKey: 'smoke-' + Date.now() }, actor)));
        const note = await request('/v1/agents/worker-a/memory/INDEX');
        const logs = await request('/v1/agents/worker-a/logs', 'GET', undefined, 'coordinator');
        console.log(JSON.stringify({ status: 'passed', parallelTools: results.map(r => r.output), memoryVersion: note.version, coordinatorVisibleEvents: logs.length }));
    }
    else
        throw new Error('Commands: serve, smoke, demo, harness-smoke');
}
catch (error) {
    await cleanup?.().catch(() => { });
    console.error(JSON.stringify(redact({ status: 'failed', code: (error as any).code ?? 'ERROR', message: error instanceof Error ? error.message : 'Failed' })));
    process.exitCode = 1;
}
