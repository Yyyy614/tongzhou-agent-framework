import { test, expect } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
import { HarnessRuntime } from '../src/runtime.js';
import { TaskQueue } from '../src/tasks.js';
import { FrameworkError } from '../src/errors.js';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(delegation = false) {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/native-boundary-')) });
    await host.installPlugin(resolve('fixtures/conformance-plugin'));
    await host.putActor({ id: 'alice', companyId: 'one', role: 'employee', permissions: ['report.self.write', ...(delegation ? ['agent.execute:target'] : [])] });
    await host.putActor({ id: 'bob', companyId: 'one', role: 'employee', permissions: [] });
    await host.putAgent({ id: 'worker', ownerId: 'alice', companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [], servicePermissions: ['report.self.write'], ...(delegation ? { delegates: ['target'] } : {}) });
    await host.putAgent({ id: 'target', ownerId: 'bob', companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
    const app = await createServer(host), upstream = Fastify();
    let calls = 0;
    upstream.post('/v1/messages', async (request) => { calls++; const body = request.body as any; return { id: 'fixture', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [{ type: 'text', text: 'native result' }], stop_reason: body.messages[0].content === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 80, output_tokens: 12 } }; });
    await upstream.listen({ host: '127.0.0.1', port: 0 });
    const runtime = new HarnessRuntime(app, host, { apiKey: 'fixture', upstreamURL: upstream.listeningOrigin });
    const queue = new TaskQueue(host, { async run() { return { id: '00000000-0000-4000-8000-000000000001', state: 'succeeded', output: 'child summary' }; } });
    await queue.open();
    runtime.enableDelegation(queue);
    queue.registerRoutes(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const headers = { authorization: 'Bearer ' + await host.issueAccessToken('alice') };
    const connect = async () => app.inject({ method: 'POST', url: '/v1/harness/clients', headers, payload: { agentId: 'worker' } });
    const path = (lease: any, suffix: string) => '/internal/client/' + lease.id + suffix;
    const auth = (lease: any, sessionId = 'session-a', turnId = 'turn-a') => ({ authorization: 'Bearer ' + lease.token, 'x-deepseek-harness-session-id': sessionId, 'x-company-turn-id': turnId });
    return { host, app, runtime, queue, headers, connect, calls: () => calls,
        start: (l: any, s = 'session-a', t = 'turn-a') => app.inject({ method: 'POST', url: path(l, '/turn/start'), headers: auth(l), payload: { sessionId: s, turnId: t } }),
        model: (l: any, text = 'tool', s = 'session-a', t = 'turn-a') => app.inject({ method: 'POST', url: path(l, '/model/v1/messages'), headers: { ...auth(l, s, t), 'x-api-key': l.token }, payload: { model: 'deepseek-flash', max_tokens: 32, messages: [{ role: 'user', content: text }], tools: [] } }),
        tool: (l: any, name: string, args: any, s = 'session-a', t = 'turn-a') => app.inject({ method: 'POST', url: path(l, '/mcp'), headers: auth(l, s, t), payload: { jsonrpc: '2.0', id: name + '-1', method: 'tools/call', params: { name, arguments: args } } }),
        cancel: (l: any, s = 'session-a', t = 'turn-a') => app.inject({ method: 'POST', url: path(l, '/turn/cancel'), headers: auth(l), payload: { sessionId: s, turnId: t } }),
        status: async (l: any) => (await app.inject({ url: '/v1/harness/clients/' + l.id, headers })).json(),
        close: async () => { await runtime.close(); await queue.close(); await app.close(); await upstream.close(); await host.close(); } };
}
test('a native connection cannot mix model, tools or cancellation between chats', async () => {
    const f = await fixture();
    try {
        const l = (await f.connect()).json();
        expect((await f.start(l)).statusCode).toBe(200);
        expect((await f.model(l)).statusCode).toBe(200);
        expect((await f.start(l, 'session-b', 'turn-b')).statusCode).toBe(409);
        expect((await f.model(l, 'finish', 'session-b', 'turn-b')).statusCode).toBe(409);
        expect((await f.tool(l, 'report_record', { summary: 'wrong chat' }, 'session-b', 'turn-b')).statusCode).toBe(409);
        expect((await f.cancel(l, 'session-b', 'turn-b')).json().accepted).toBe(false);
        expect((await f.status(l)).lastRun.state).toBe('running');
        expect((await f.tool(l, 'report_record', { summary: 'right chat' })).json().result.isError).toBe(false);
        await f.model(l, 'finish');
        expect((await f.status(l)).lastRun.state).toBe('succeeded');
        expect(f.calls()).toBe(2);
    }
    finally {
        await f.close();
    }
});
test('cancellation during admission prevents the pending model request', async () => {
    const f = await fixture();
    const entered = deferred(), gate = deferred();
    const original = f.runtime.openClientTurn.bind(f.runtime);
    f.runtime.openClientTurn = async (request) => { entered.resolve(); await gate.promise; return original(request); };
    try {
        const l = (await f.connect()).json();
        await f.start(l);
        const model = f.model(l);
        await entered.promise;
        expect((await f.cancel(l)).json().accepted).toBe(true);
        gate.resolve();
        expect((await model).statusCode).toBe(409);
        expect(f.calls()).toBe(0);
        expect((await f.status(l)).lastRun.state).toBe('cancelled');
    }
    finally {
        gate.resolve();
        await f.close();
    }
});
test('cancellation while waiting for budget sends no provider request and waits for settlement', async () => {
    const f = await fixture(), entered = deferred(), gate = deferred();
    const reserve = f.runtime.budget.reserve.bind(f.runtime.budget);
    f.runtime.budget.reserve = async (...args) => { entered.resolve(); await gate.promise; return reserve(...args); };
    try {
        const l = (await f.connect()).json(); await f.start(l);
        const model = f.model(l); await entered.promise;
        const cancelled = f.cancel(l);
        await new Promise(resolve => setTimeout(resolve, 50));
        expect((await f.status(l)).lastRun.state).toBe('running');
        gate.resolve(); await model; await cancelled;
        expect(f.calls()).toBe(0);
        expect((await f.status(l)).lastRun.state).toBe('cancelled');
        expect((await f.runtime.usage({principalId:'alice',agentId:'worker'})).requests).toBe(0);
    } finally { gate.resolve(); await f.close(); }
});
test('a finishing scope rejects new tools while its terminal state is being persisted', async () => {
    const f = await fixture(), entered = deferred(), gate = deferred();
    const query = f.host.db.pool.query.bind(f.host.db.pool); let calls = 0;
    const report = f.host.recordReport.bind(f.host);
    f.host.recordReport = async request => { calls++; return report(request); };
    let turn:any;
    try {
        turn = await f.runtime.openClientTurn({principalId:'alice',agentId:'worker',prompt:'finish',idempotencyKey:'finish-admission'});
        (f.host.db.pool as any).query = async (...args:any[]) => { if(typeof args[0]==='string'&&args[0].startsWith('UPDATE runs SET state=')&&args[1]?.[0]===turn.id){entered.resolve();await gate.promise;}return (query as any)(...args); };
        const finishing = f.runtime.finishClientTurn(turn.id,'done'); await entered.promise;
        const response=await f.app.inject({method:'POST',url:'/internal/mcp/'+turn.id,headers:{authorization:'Bearer '+turn.token},payload:{jsonrpc:'2.0',id:'late',method:'tools/call',params:{name:'report_record',arguments:{summary:'late'}}}});
        expect(response.statusCode).toBe(401); expect(calls).toBe(0);
        gate.resolve(); await finishing;
    } finally { gate.resolve(); (f.host.db.pool as any).query=query; await f.close(); }
});
test('an executor failure closes tool admission before persisting its failed outcome', async () => {
    const f = await fixture(), remote = Fastify(), entered = deferred(), gate = deferred();
    let gateway:any, calls=0; const query=f.host.db.pool.query.bind(f.host.db.pool);
    remote.post('/rpc',async request=>{const rpc=request.body as any;gateway=rpc.params.context.gateway;return{jsonrpc:'2.0',id:rpc.id,result:{}};});
    await remote.listen({host:'127.0.0.1',port:0});
    let running:Promise<any>|undefined;
    try {
        f.host.options.connections={broken:{url:remote.listeningOrigin+'/rpc'}};
        await f.host.putAgent({...await f.host.db.get<any>('agents','worker'),runtime:'remote',connectionRef:'broken'});
        const report=f.host.recordReport.bind(f.host);f.host.recordReport=async r=>{calls++;return report(r);};
        (f.host.db.pool as any).query=async(...args:any[])=>{if(typeof args[0]==='string'&&args[0].startsWith('UPDATE runs SET state=$3')){entered.resolve();await gate.promise;}return(query as any)(...args);};
        running=f.runtime.run({principalId:'alice',agentId:'worker',prompt:'failed executor',idempotencyKey:'failure-close'}).catch(error=>error);
        await entered.promise;
        const response=await f.app.inject({method:'POST',url:new URL(gateway.mcpURL).pathname,headers:{authorization:'Bearer '+gateway.token},payload:{jsonrpc:'2.0',id:'late',method:'tools/call',params:{name:'report_record',arguments:{summary:'too late'}}}});
        expect(response.statusCode).toBe(401);expect(calls).toBe(0);
        gate.resolve();await running;
    } finally {gate.resolve();await running;(f.host.db.pool as any).query=query;await remote.close();await f.close();}
});
test('cancellation holds the run slot until in-flight tools have a known outcome', async () => {
    const f = await fixture();
    const entered = deferred(), gate = deferred();
    f.host.recordReport = async () => { entered.resolve(); await gate.promise; throw new FrameworkError('RESULT_UNKNOWN', 'Receipt is missing'); };
    try {
        const l = (await f.connect()).json();
        await f.start(l);
        await f.model(l);
        const tool = f.tool(l, 'report_record', { summary: 'pending' });
        await entered.promise;
        const cancelled = f.cancel(l);
        await new Promise(resolve => setTimeout(resolve, 50));
        expect((await f.status(l)).lastRun.state).toBe('running');
        await expect(f.runtime.openClientTurn({ principalId: 'alice', agentId: 'worker', prompt: 'another', idempotencyKey: 'another' })).rejects.toMatchObject({ code: 'CONFLICT' });
        gate.resolve();
        await tool;
        await cancelled;
        expect((await f.status(l)).lastRun.state).toBe('reconciliation_required');
    }
    finally {
        gate.resolve();
        await f.close();
    }
});
test('connection capacity is reserved before async context loading and configuration changes require refresh', async () => {
    const f = await fixture();
    const original = f.host.buildContext.bind(f.host);
    f.host.buildContext = async (request) => { await new Promise(resolve => setTimeout(resolve, 100)); return original(request); };
    try {
        const leases = await Promise.all(Array.from({ length: 6 }, () => f.connect()));
        expect(leases.filter(r => r.statusCode === 201)).toHaveLength(5);
        expect(leases.filter(r => r.statusCode === 429)).toHaveLength(1);
        const l = leases.find(r => r.statusCode === 201)!.json();
        const agent = await f.host.db.get<any>('agents', 'worker');
        await f.host.putAgent({ ...agent, instructions: 'new revision' });
        expect((await f.start(l)).statusCode).toBe(409);
        expect(f.calls()).toBe(0);
    }
    finally {
        await f.close();
    }
});
test('an authorized native coordinator has a durable parent and can delegate without private memory', async () => {
    const f = await fixture(true);
    try {
        const l = (await f.connect()).json();
        await f.start(l);
        await f.model(l);
        const result = (await f.tool(l, 'task_delegate', { agentId: 'target', prompt: 'bounded work' })).json();
        expect(result.result.isError).toBe(false);
        const child = JSON.parse(result.result.content[0].text);
        const parent = (await f.status(l)).lastRun.taskId;
        expect(child.parentTaskId).toBe(parent);
        await f.queue.startWorker();
        await expect.poll(async () => (await f.queue.get(child.id, 'alice')).state, { timeout: 3000 }).toBe('succeeded');
        const status = (await f.tool(l, 'task_status', { taskId: child.id })).json();
        expect(JSON.parse(status.result.content[0].text).summary).toBe('child summary');
        expect(JSON.stringify(status)).not.toContain('markdown');
        await f.model(l, 'finish');
        expect((await f.queue.get(parent, 'alice')).state).toBe('succeeded');
        expect((await f.host.db.pool.query('SELECT run_id FROM budgets')).rows.map(r => r.run_id)).toEqual([parent]);
    }
    finally {
        await f.close();
    }
});
