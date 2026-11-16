import type { FastifyInstance } from 'fastify';
import type { Framework } from './index.js';
import { fail, FrameworkError, AdmissionBusyError } from './errors.js';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
import type { Agent, Actor } from './types.js';
import { RemoteAgentAdapter } from './remote-runtime.js';
import { ExecutionBudget } from './budget.js';
import type { TaskQueue } from './tasks.js';
import { authenticateRequest } from './console-auth.js';
import { companyBundleDirectory, nativePresetRows } from './presets.js';
import { pathToFileURL } from 'node:url';
import { HarnessClients } from './harness-clients.js';
import { contentHash } from './contracts.js';
import { RuntimeContext } from './runtime-context.js';
import{workNoteSchema}from'./work-memory.js';
import { reportSchema, type StructuredReport } from './work-results.js';
import type { ResourceRef } from './resources.js';
import { assessCompanyEvent } from './event-assessor.js';
import {recallSchema}from'./knowledge.js';
export interface RuntimeOptions {
    contextWindowTokens?:number;
    maxOutputTokens?:number;
    toolReserveTokens?:number;
    publicOrigin?: string;
    apiKey: string;
    upstreamURL: string;
    model?: string;
    maxConcurrentRuns?: number;
}
interface RunRequest {
    executionProfile?:'memory-maintenance';
    contextResources?: ResourceRef[];
    contextWorkId?: string;
    contextWorkCleared?: boolean;
    clientSessionId?: string;
    clientConnectionId?: string;
    expectedAgentRevision?: string;
    initialContextRefs?: Array<{
        noteId: string;
        version: number;
    }>;
    principalId: string;
    agentId: string;
    prompt: string;
    idempotencyKey: string;
    taskId?: string;
    budgetGroupId?: string;
    initiatingPrincipalId?: string;
    workId?:string;
    workRound?:number;
    workInputId?:string;
    workControlRevision?:number;
}
interface RunTool {
    effect?:'read'|'write'|'host';
    companyRef?:string;
    pluginVersion?:string;
    name: string;
    description: string;
    inputSchema: any;
    execute: (input: any, key: string) => Promise<unknown>;
}
interface Scope {
    modelBusy?:boolean;
    context?: RuntimeContext;
    report?: StructuredReport;
    workStop?:Promise<void>;
    pendingOperations?: Set<Promise<unknown>>;
    admissionClosed?: boolean;
    finishing?: Promise<void>;
    external?: boolean;
    modelAbort?: AbortController;
    id: string;
    request: RunRequest;
    token: string;
    tools: RunTool[];
    calls: number;
    expiresAt: number;
    harness?: DeepSeekHarness;
    remote?: RemoteAgentAdapter;
    cancelled?: boolean;
    toolCalls?: number;
    reconcile?: boolean;
    approvalRequired?: boolean;
    cancellationAccepted?: boolean;
    metadata: Record<string, unknown>;
    contextRefs?: Array<{
        noteId: string;
        version: number;
    }>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function childEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP'])
        if (process.env[key])
            env[key] = process.env[key];
    return env;
}
export class HarnessRuntime {
    assessEvent(input:import('./event-routing.js').EventAssessment){return assessCompanyEvent(this.host,this.options.model??'deepseek-flash',input);}
    private closed = false;
    readonly budget: ExecutionBudget;
    private scopes = new Map<string, Scope>();
    private running = new Set<Promise<unknown>>();
    private queue?: TaskQueue;
    enableDelegation(queue: TaskQueue) { this.queue = queue; }
    constructor(readonly app: FastifyInstance, readonly host: Framework, readonly options: RuntimeOptions) {
        if (options.maxConcurrentRuns !== undefined && (!Number.isInteger(options.maxConcurrentRuns) || options.maxConcurrentRuns < 1 || options.maxConcurrentRuns > 16)) fail('INVALID_INPUT','Host concurrency must be between one and sixteen');
        host.channels.configureFallback(options.apiKey, options.upstreamURL, options.model ?? 'deepseek-flash');
        if (options.publicOrigin) {
            const url = new URL(options.publicOrigin);
            if (url.username || url.password || url.search || url.hash || url.pathname.length>100 || !/^(?:\/[A-Za-z0-9_-]+)*\/?$/u.test(url.pathname) || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fail('INVALID_INPUT', 'PUBLIC_ORIGIN requires HTTPS with an optional deployment path, or loopback HTTP for local verification');
            options.publicOrigin = url.origin+url.pathname.replace(/\/$/u,'');
        }
        this.budget = new ExecutionBudget(host.db);
        const upstream = new URL(options.upstreamURL);
        if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash)
            fail('INVALID_INPUT', 'Invalid provider URL');
        app.post<{
            Params: {
                id: string;
            };
        }>('/internal/model/:id/v1/messages', async (request, reply) => {
            const scope = await this.scope(request.params.id, String(request.headers['x-api-key'] ?? ''));
            if(scope.modelBusy)fail('CONFLICT','This turn already has a model request');scope.modelBusy=true;
            try{const result = await this.operation(scope, () => this.proxyModel(scope, request.body));return reply.code(result.status).header('content-type', result.contentType).send(result.text);}finally{scope.modelBusy=false;}
        });
        app.post<{
            Params: {
                id: string;
            };
        }>('/internal/mcp/:id', async (request, reply) => {
            const scope = await this.scope(request.params.id, (request.headers.authorization ?? '').replace(/^Bearer /u, ''));
            const rpc = request.body as any;
            if (rpc?.jsonrpc !== '2.0' || typeof rpc.method !== 'string')
                fail('INVALID_INPUT', 'Invalid MCP request');
            if (rpc.id === undefined)
                return reply.code(202).send();
            let result: unknown;
            if (rpc.method === 'initialize')
                result = { protocolVersion: rpc.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'company-agent-framework', version: '0.1.0' }, instructions: 'These tools are authorized for this task only. Memory is private to this agent.' };
            else if (rpc.method === 'ping')
                result = {};
            else if (rpc.method === 'tools/list')
                result = { tools: scope.tools.map(({ name,description,inputSchema }) => ({name,description,inputSchema})) };
            else if (rpc.method === 'tools/call') {
                scope.toolCalls = (scope.toolCalls ?? 0) + 1;
                if (scope.toolCalls > 16)
                    fail('BUDGET_EXCEEDED', 'Run tool call limit reached');
                const tool = scope.tools.find(t => t.name === rpc.params?.name);
                if (!tool)
                    fail('PERMISSION_DENIED', 'Unknown or unauthorized tool');
                await this.operation(scope, async () => {
                    await scope.context?.validate();
                    const { actor, agent } = await this.host.authorize(scope.request.principalId, scope.request.agentId);
                    this.assertOpen(scope);
                    const permission = ({ memory_read: 'memory.self.read', memory_search: 'memory.self.read', memory_write: 'memory.self.propose_write',memory_rebuild:'memory.self.propose_write', report_record: 'report.self.write',work_report:'report.self.write' } as Record<string, string>)[tool.name];
                    if (permission && (!agent.servicePermissions?.includes(permission) || !await this.host.hasPermission(actor,agent,permission) || !this.host.bindings(agent).some(b => this.host.registry.get(b.pluginId, b.pluginVersion).manifest.permissions.includes(permission))))
                        fail('PERMISSION_DENIED', 'Service grant was revoked');
                    if(tool.companyRef){const plugin=this.host.pluginFor(agent,tool.companyRef);if(plugin.version!==tool.pluginVersion||!agent.allowedTools.includes(tool.companyRef)||!await this.host.hasPermission(actor,agent,'tool.invoke:'+tool.companyRef,tool.companyRef))fail('PERMISSION_DENIED','Tool binding changed before action or receipt access');await this.host.market.guardTool(actor,agent,tool.companyRef);}
                    if (!this.host.registry.ajv.validate(tool.inputSchema, rpc.params?.arguments ?? {}))
                        fail('INVALID_INPUT', 'MCP tool arguments failed schema validation');
                    try {
                        await scope.context?.attestToolInput(tool.name,rpc.params?.arguments??{});
                        const readKind=tool.companyRef&&tool.effect==='read'?'plugin_read':tool.name;
                        scope.context?.beginRead(readKind,rpc.params?.arguments??{});
                        const invoke=()=>tool.execute(rpc.params?.arguments??{},scope.id+':mcp:'+String(rpc.id));
                        const effect=scope.request.workId&&tool.effect&&tool.effect!=='read'&&this.host.coordination;
                        const execution=effect?await this.host.coordination!.control.actions.execute(scope.request,(tool.companyRef??tool.name)+'@'+(tool.pluginVersion??'host-1'),rpc.params?.arguments??{},invoke,scope.id):{value:await invoke(),reused:false,actionId:null};
                        const output=execution.value;
                        scope.context?.completeRead(readKind,rpc.params?.arguments??{},output);
                        if (tool.name === 'memory_read') {
                            const note = output as {
                                noteId: string;
                                version: number;
                            };
                            scope.contextRefs = [...(scope.contextRefs ?? []).filter(r => r.noteId !== note.noteId), { noteId: note.noteId, version: note.version }];
                            await scope.context?.note(output);
                        }
                        if(tool.name==='resource_read'||tool.name==='resource_create')await scope.context?.resource(output);
                        if(tool.name==='resource_index')for(const item of (output as any).items)await scope.context?.resource(item,true);
                        if(tool.name==='resource_recall')for(const item of (output as any).fragments)await scope.context?.resource(await this.host.resources.read(actor.id,item.ref.id,item.ref.version,0,1));
                        if(tool.name==='skill_read'&&(output as any)?.resource)await scope.context?.resource((output as any).resource);
                        const written=['memory_write','memory_rebuild'].includes(tool.name)?output:tool.companyRef&&tool.effect==='host'?(output as any)?.output:null;
                        if(written&&typeof (written as any).noteId==='string'&&Number.isInteger((written as any).version))await scope.context?.wroteMemory(written);
                        if(['work_memory_save','work_memory_rebuild'].includes(tool.name))await scope.context?.wroteWorkMemory();
                        await this.host.db.audit(execution.reused?'runtime.tool_reused':'runtime.tool_succeeded', { principalId: scope.request.principalId, agentId: scope.request.agentId, runId: scope.id, toolName: tool.name, requestRef: String(rpc.id),actionId:execution.actionId, noteRef: tool.name === 'memory_read' ? { noteId: (output as any).noteId, version: (output as any).version } : undefined });
                        result = { content: [{ type: 'text', text: JSON.stringify(output) },...(execution.reused?[{type:'text',text:JSON.stringify({companyExecution:{reused:true,actionRef:execution.actionId}})}]:[])], isError: false };
                    }
                    catch (error) {
                        const e = error as FrameworkError;
                        await this.host.db.audit('runtime.tool_failed', { principalId: scope.request.principalId, agentId: scope.request.agentId, runId: scope.id, toolName: tool.name, code: e.code ?? 'TOOL_ERROR' });
                        if (['RESULT_UNKNOWN', 'TIMEOUT', 'PLUGIN_EXITED'].includes(e.code))
                            scope.reconcile = true;
                        if (e.code === 'APPROVAL_REQUIRED')
                            scope.approvalRequired = true;
                        result = { content: [{ type: 'text', text: JSON.stringify({ error: { code: e.code ?? 'TOOL_ERROR', message: e instanceof FrameworkError ? e.message : 'Tool failed' } }) }], isError: true };
                    }
                });
                await scope.context?.receipt(tool.name,rpc.params?.arguments??{},result);
            }
            else
                return reply.send({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not supported' } });
            return reply.send({ jsonrpc: '2.0', id: rpc.id, result });
        });
        app.get('/internal/mcp/:id', async (request, reply) => reply.code(405).send());
        app.post('/v1/runs', { schema: { body: { type: 'object', additionalProperties: false, required: ['agentId', 'prompt', 'idempotencyKey'], properties: { agentId: { type: 'string' }, prompt: { type: 'string', minLength: 1, maxLength: 8000 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 160 } } } } }, async (request) => { const actor = await authenticateRequest(this.host, request); return this.run({ ...request.body as any, principalId: actor.id }); });
        app.get<{
            Params: {
                id: string;
            };
        }>('/v1/runs/:id', async (request) => { const actor = await authenticateRequest(this.host, request); return this.get(request.params.id, actor.id); });
        app.post<{
            Params: {
                id: string;
            };
        }>('/v1/runs/:id/cancel', async (request) => { const actor = await authenticateRequest(this.host, request); return this.cancel(request.params.id, actor.id); });
        app.get<{
            Params: {
                agentId: string;
            };
        }>('/v1/agents/:agentId/usage', async (request) => { const actor = await authenticateRequest(this.host, request); return this.usage({ principalId: actor.id, agentId: request.params.agentId }); });
        new HarnessClients(app, this);
    }
    private async proxyModel(scope: Scope, body: any) {
        this.assertOpen(scope);
        if(!body||typeof body!=='object')fail('INVALID_INPUT','Invalid model request');
        if(!scope.context){
            const {actor,agent}=await this.host.authorize(scope.request.principalId,scope.request.agentId);
            let workId=scope.request.contextWorkId??scope.request.workId;
            if(this.host.coordination){
                if(scope.request.contextWorkCleared&&scope.request.clientSessionId)await this.host.workMemory.unbind(actor.id,agent.id,scope.request.clientSessionId);
                const related=await this.host.workMemory.resolve(actor.id,agent.id,{entryKey:scope.request.contextWorkCleared?undefined:scope.request.clientSessionId,workId,continueWork:!scope.request.contextWorkCleared&&/刚才|上次|继续|接着|\b(?:continue|resume)\b/iu.test(scope.request.prompt)});
                if(related.status==='choose')fail('CONFLICT','请选择要继续的工作，不会推测或合并工作。',{candidates:related.candidates});
                if(related.status==='resolved')workId=related.workId;
            }
            scope.metadata.workId=scope.request.workId??workId??null;
            scope.metadata.workBinding=scope.request.workId?'execution':workId?'reference':null;
            scope.context=await RuntimeContext.create(this.host,actor,agent,scope.request.prompt,scope.request.contextResources,workId,scope.id);
        }
        body=scope.context.request(body);
        const allowed = new Set(scope.tools.map(t => 'mcp__company__' + t.name));
        if (!body || body.model !== (this.options.model ?? 'deepseek-flash') || !Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > (this.options.maxOutputTokens??1024) || JSON.stringify(body).length > 128000 || !Array.isArray(body.tools ?? []) || (body.tools ?? []).some((t: any) => !allowed.has(t.name)))
            fail('INVALID_INPUT', 'Model request exceeds managed policy');
        body.tools=scope.tools.map(tool=>({name:'mcp__company__'+tool.name,description:tool.description,input_schema:tool.inputSchema}));
        if (++scope.calls > 8)
            fail('BUDGET_EXCEEDED', 'Run model request limit reached');
        const estimatedInput = Math.ceil(Buffer.byteLength(JSON.stringify(body), 'utf8') / 2);
        const window=this.options.contextWindowTokens??16000,toolReserve=this.options.toolReserveTokens??2048;
        scope.context.setBudget({contextWindowTokens:window,estimatedInputTokens:estimatedInput,outputReserveTokens:body.max_tokens,toolReserveTokens:toolReserve,packingPolicy:'constraints-work-memory-recall-references'});
        if (estimatedInput+body.max_tokens+toolReserve > window)
            fail('CONTEXT_BUDGET_EXCEEDED', 'Final model request exceeds context budget');
        const reservation = estimatedInput + body.max_tokens, budgetId = scope.request.budgetGroupId ?? scope.id;
        let status = 0, usage: any = null, providerRequestId: string | null = null, reserved = false, dispatched = false;
        let channel: { channelId?: string; accountGroup?: string; provider?: string; attempts?: unknown } = {};
        const started = Date.now(), controller = new AbortController();
        scope.modelAbort = controller;
        try {
            await this.budget.reserve(budgetId, reservation);
            reserved = true;
            await this.host.authorize(scope.request.principalId, scope.request.agentId);
            this.assertOpen(scope);
            let response;
            try { response = await this.host.channels.forward(scope.request.principalId, body, controller.signal, async () => { await this.host.authorize(scope.request.principalId, scope.request.agentId); await this.host.coordination?.control.guardRun(scope.id); await scope.context!.validate();await scope.context!.dispatched(body,scope.calls); this.assertOpen(scope); }); }
            catch (error) { if ((error as any).code === 'RESULT_UNKNOWN') { dispatched = true; scope.reconcile = true; channel = (error as any).details ?? {}; } throw error; }
            dispatched = true; channel = { channelId: response.channelId, accountGroup: response.accountGroup, provider: response.provider, attempts: response.attempts };
            providerRequestId = response.providerRequestId; status = response.status;
            const { text, contentType } = response;
            if (status >= 500) scope.reconcile = true;
            usage = this.extractUsage(text, contentType);
            if(status>=200&&status<300)scope.context.response(text,contentType);
            if (!Number.isInteger(usage?.input_tokens) || !Number.isInteger(usage?.output_tokens) || usage.input_tokens < 0 || usage.output_tokens < 0)
                usage = null;
            return { status, text, contentType };
        }
        finally {
            if (scope.modelAbort === controller)
                scope.modelAbort = undefined;
            try {
                if (reserved) await this.budget.settle(budgetId, reservation, usage ? Number(usage.input_tokens) + Number(usage.output_tokens) : dispatched ? null : 0);
                if (dispatched) await this.host.db.pool.query('INSERT INTO usage(id,run_id,data) VALUES($1,$2,$3)', [randomUUID(), scope.id, JSON.stringify({ ...scope.metadata, ...channel,purpose:'execution', principalId: scope.request.principalId, agentId: scope.request.agentId, provider: channel.provider ?? 'deepseek', providerRequestId, model: this.options.model ?? 'deepseek-flash', status, inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null, cacheReadTokens: usage?.cache_read_input_tokens ?? 0, measurement: usage ? 'provider' : 'unavailable', contextManifest: { ...scope.context?.manifest(), estimatedInputTokens: estimatedInput, requestChars: JSON.stringify(body).length, tools: [...allowed] }, durationMs: Date.now() - started })]);
            } catch (error) {
                if (dispatched) { scope.reconcile = true; throw new FrameworkError('RESULT_UNKNOWN', 'Model usage persistence needs reconciliation; the request was not replayed'); }
                throw error;
            }
        }
    }
    private assertOpen(scope: Scope) {
        if (scope.cancelled || scope.cancellationAccepted || scope.finishing || scope.admissionClosed || Date.now() > scope.expiresAt || this.scopes.get(scope.id) !== scope)
            fail('UNAUTHENTICATED', 'Run is stopped or finishing');
    }
    private operation<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
        this.assertOpen(scope);
        const pending = Promise.resolve().then(async()=>{await this.host.coordination?.control.guardRun(scope.id);this.assertOpen(scope);return work();});
        scope.pendingOperations ??= new Set();
        scope.pendingOperations.add(pending);
        return pending.finally(() => { scope.pendingOperations?.delete(pending); });
    }
    private extractUsage(text: string, contentType: string) {
        if (contentType.includes('application/json')) {
            try {
                return JSON.parse(text).usage ?? null;
            }
            catch {
                return null;
            }
        }
        let usage: any = null;
        for (const line of text.split('\n'))
            if (line.startsWith('data: ')) {
                try {
                    const e = JSON.parse(line.slice(6));
                    const u = e.message?.usage ?? e.usage;
                    if (u)
                        usage = { ...usage, ...u };
                }
                catch { }
            }
        return usage;
    }
    private async scope(id: string, token: string) {
        const scope = this.scopes.get(id);
        if (!scope || scope.cancelled || scope.cancellationAccepted || scope.finishing || scope.admissionClosed || Date.now() > scope.expiresAt || token.length !== scope.token.length || !timingSafeEqual(Buffer.from(token), Buffer.from(scope.token)))
            fail('UNAUTHENTICATED', 'Run credential is invalid or expired');
        await this.host.authorize(scope.request.principalId, scope.request.agentId);
        await this.host.coordination?.control.guardRun(scope.id);
        this.assertOpen(scope);
        return scope;
    }
    private async tools(actor: Actor, agent: Agent, runId: string, describing = false): Promise<RunTool[]> {
        const plugins = this.host.bindings(agent).map(p => this.host.registry.get(p.pluginId, p.pluginVersion));
        const bound = { principalId: actor.id, agentId: agent.id };
        const tools: RunTool[] = [];
        for (const plugin of plugins) {
            for (const tool of plugin.manifest.provides.tools) {
                const ref = plugin.id + ':' + tool.id;
                if (!agent.allowedTools.includes(ref) || !await this.host.hasPermission(actor,agent,'tool.invoke:'+ref,ref))
                    continue;
                tools.push({ name: 'tool_' + tool.id.replace(/[^A-Za-z0-9_]/gu, '_').slice(0, 26) + '_' + hash(ref).slice(0, 16),effect:tool.effect,companyRef:ref,pluginVersion:plugin.version, description: `Invoke ${ref} (${tool.effect})`, inputSchema: JSON.parse(await readFile(await this.host.registry.packagePath(plugin.directory, tool.inputSchema), 'utf8')), execute: (input, key) => this.host.invoke({ ...bound, runId, toolRef: ref, input, idempotencyKey: key }) });
            }
        }
        const grant = async (p: string) => plugins.some(plugin => plugin.manifest.permissions.includes(p)) && agent.servicePermissions?.includes(p) && await this.host.hasPermission(actor,agent,p);
        if (await grant('memory.self.read')) {
            tools.push({ name: 'memory_read', description: 'Read one bounded private note page with current source permissions. Follow nextOffset only as needed.', inputSchema: { type: 'object', additionalProperties: false, required: ['noteId'], properties: { noteId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$' },offset:{type:'integer',minimum:0} } }, execute: async (input) => {
                    if (Object.keys(input).some(k => !['noteId','offset'].includes(k)))
                        fail('INVALID_INPUT', 'Unexpected memory parameter');
                    return this.host.memory.page({ ...bound, noteId: input.noteId },input.offset??0,this.scopes.get(runId)?.context?.readAllowance()??4000);
                } });
            tools.push({ name: 'memory_search', description: 'Find note references and short excerpts in your own memory.', inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', maxLength: 200 } } }, execute: input => this.host.memory.search({ ...bound, query: input.query }) });
        }
        if (await grant('memory.self.propose_write')){
            tools.push({ name: 'memory_write',effect:'host', description: 'Update your private notes using the version you read. Never grant permissions through notes.', inputSchema: { type: 'object', additionalProperties: false, required: ['noteId', 'markdown', 'expectedVersion', 'sourceRefs'], properties: { noteId: { type: 'string' }, markdown: { type: 'string', maxLength: 32000 }, expectedVersion: { type: 'integer', minimum: 0 }, sourceRefs: { type: 'array', items: { type: 'string' } } } }, execute: async input => this.host.writeMemory({ ...input, ...bound },await this.host.provenance.snapshot(runId)) });
            tools.push({name:'memory_rebuild',effect:'host',description:'Rebuild an invalid private note from a fresh context and current evidence. The old note must not have entered this run. Old versions remain archived; this does not publish anything.',inputSchema:{type:'object',additionalProperties:false,required:['noteId','markdown','expectedVersion','sourceRefs'],properties:{noteId:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$'},markdown:{type:'string',maxLength:12000},expectedVersion:{type:'integer',minimum:0},sourceRefs:{type:'array',maxItems:32,items:{type:'string',maxLength:240}}}},execute:async input=>this.host.memory.write({...input,...bound},await this.host.provenance.snapshot(runId),true)});
        }
        if (await grant('report.self.write')) {
            tools.push({ name: 'report_record',effect:'host', description: 'Record a concise work report for this agent.', inputSchema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string', maxLength: 8000 } } }, execute: input => this.host.recordReport({ ...bound, runId, summary: input.summary }) });
            tools.push({name:'work_report',effect:'host',description:'Record reported facts, versioned evidence, deliverables and unresolved issues. Copy refs ONLY from resource_read.resourceRef or skill_read.resourceRef, never the market release id. This never changes completion/approval state. Uncited claims remain private.',inputSchema:reportSchema,execute:async input=>{const scope=this.scopes.get(runId);if(!scope)fail('UNAUTHENTICATED','No active report scope');for(const ref of [...input.artifacts,...input.facts.flatMap((f:any)=>f.refs),...input.issues.flatMap((i:any)=>typeof i==='string'?[]:i.refs)])await this.host.resources.read(actor.id,ref.id,ref.version);scope.report=input;return{recorded:true,facts:input.facts.length,artifacts:input.artifacts.length};}});
        }
        const currentWork=()=>{const scope=this.scopes.get(runId),workId=scope?.context?.pack.workId??scope?.request.workId??scope?.request.contextWorkId;if(!workId)fail('CONFLICT','先关联一项工作，再读取或保存工作笔记。');return workId as string;};
        tools.push({name:'experience_propose',effect:'host',description:'Save a private candidate lesson with actual input provenance. This does not validate, approve, publish, or change company rules. A human must validate and submit it for independent review.',inputSchema:{type:'object',additionalProperties:false,required:['title','lesson','refs'],properties:{title:{type:'string',minLength:1,maxLength:100},lesson:{type:'string',minLength:1,maxLength:8000},refs:workNoteSchema.properties.artifacts}},execute:async(input,key)=>this.host.experiences.create(actor.id,{...input,agentId:agent.id,...(this.scopes.get(runId)?.context?.pack.workId?{workId:this.scopes.get(runId)?.context?.pack.workId}:{}),idempotencyKey:key},await this.host.provenance.snapshot(runId))});
        tools.push({name:'work_memory_read',effect:'read',description:'Restore bounded current work memory. Default returns compact state and omissions; request a named section and follow nextOffset to expand within the same budget. Stale notes are omitted.',inputSchema:{type:'object',additionalProperties:false,properties:{section:{enum:['decisions','blockers','nextSteps','artifacts']},offset:{type:'integer',minimum:0}}},execute:async input=>{const workId=currentWork(),limit=this.scopes.get(runId)?.context?.readAllowance()??2800;if(!input.section){const c=await this.host.workMemory.compact(actor.id,workId,agent.id,Math.min(2800,limit)),v=JSON.parse(c.text);return{workId,revision:c.ref?.revision??0,note:{goal:v.goal,decisions:v.decisions,blockers:v.blockers,nextSteps:v.nextSteps,artifacts:v.artifacts},facts:v.facts,sourceValidity:v.sourceValidity,omissions:c.omissions,nextOffset:null};}const current=await this.host.workMemory.read(actor.id,workId,agent.id);if(current.derivedValidity!=='current'||current.visibility!=='private-work-memory')return{workId,revision:current.revision,sourceValidity:current.derivedValidity,items:[],nextOffset:null,notice:'旧笔记未采用，请基于新证据重新整理。'};const all=(current.note as any)[input.section],start=input.offset??0,items:any[]=[];for(const item of all.slice(start)){if(JSON.stringify(items.concat(item)).length>limit)break;items.push(item);}return{workId,revision:current.revision,section:input.section,items,offset:start,nextOffset:start+items.length<all.length?start+items.length:null};}});
        const {idempotencyKey:ignoredKey,...noteProperties}=workNoteSchema.properties;
        tools.push({name:'work_memory_save',effect:'host',description:'Save bounded work goals, noted decisions, blockers and next steps using the current note revision. Host status, approvals and action receipts cannot be changed by notes.',inputSchema:{...workNoteSchema,required:workNoteSchema.required.filter(k=>k!=='idempotencyKey'),properties:noteProperties},execute:async(input,key)=>this.host.workMemory.save(actor.id,currentWork(),agent.id,{...input,idempotencyKey:key},await this.host.provenance.snapshot(runId),false,this.scopes.get(runId)?.request.workControlRevision??this.scopes.get(runId)?.context?.pack.workControlRevision)});
        tools.push({name:'work_memory_rebuild',effect:'host',description:'Rebuild invalid work notes only from this fresh run and current evidence. Use the expectedRevision supplied by the host or read control state; never recover omitted old text. History remains and host facts cannot change.',inputSchema:{...workNoteSchema,required:workNoteSchema.required.filter(k=>k!=='idempotencyKey'),properties:noteProperties},execute:async(input,key)=>this.host.workMemory.save(actor.id,currentWork(),agent.id,{...input,idempotencyKey:key},await this.host.provenance.snapshot(runId),true,this.scopes.get(runId)?.request.workControlRevision??this.scopes.get(runId)?.context?.pack.workControlRevision)});
        tools.push({name:'resource_recall',effect:'read',description:'Recall authorized excerpts across visible domains and current work references. Explain coverage gaps; continue only within the current read budget.',inputSchema:recallSchema,execute:input=>this.host.knowledge.recall(actor.id,agent.id,{...input,...(this.scopes.get(runId)?.context?.pack.workId?{workId:this.scopes.get(runId)?.context?.pack.workId}:{}),maxChars:Math.max(160,Math.min(input.maxChars??3000,this.scopes.get(runId)?.context?.readAllowance()??3000)),maxReads:Math.min(input.maxReads??4,4,this.scopes.get(runId)?.context?.remainingReads()??4)})});
        tools.push({name:'resource_index',effect:'read',description:'Search authorized metadata with bounded pages. Use resource_recall for excerpts; this is not a complete company inventory.',inputSchema:{type:'object',additionalProperties:false,properties:{query:{type:'string',maxLength:240},domain:{type:'string',maxLength:80},limit:{type:'integer',minimum:1,maximum:16},cursor:{type:'string',maxLength:600}}},execute:input=>this.host.resources.index(actor.id,input.query??'',input.domain,{limit:input.limit??8,cursor:input.cursor})});
        tools.push({name:'resource_read',effect:'read',description:'Expand one versioned resource using current access rights and remaining budget. Follow nextOffset only; pagination depth is bounded.',inputSchema:{type:'object',additionalProperties:false,required:['id','version'],properties:{id:{type:'string',format:'uuid'},version:{type:'integer',minimum:1},offset:{type:'integer',minimum:0}}},execute:input=>this.host.resources.read(actor.id,input.id,input.version,input.offset??0,this.scopes.get(runId)?.context?.readAllowance()??4000)});
        tools.push({name:'resource_create',effect:'host',description:'Save a private versioned deliverable or source. This never publishes to a work or company. The employee must explicitly review and share through the workspace; source reading rights are not publication rights.',inputSchema:{type:'object',additionalProperties:false,required:['title','body','domain'],properties:{title:{type:'string',minLength:1,maxLength:160},body:{type:'string',maxLength:16000},domain:{type:'string',minLength:1,maxLength:80}}},execute:async(input,key)=>this.host.resources.create(actor.id,{...input,kind:'artifact',access:{scope:'personal',readerIds:[]},sourceRefs:['run:'+runId],idempotencyKey:key},{sources:await this.host.provenance.snapshot(runId)??[{kind:'unknown',id:runId,ownerId:actor.id,companyId:actor.companyId}]})});
        tools.push({name:'skill_index',effect:'read',description:'List installed company-reviewed Skills for this job. Read only the relevant Skill before use.',inputSchema:{type:'object',additionalProperties:false,properties:{}},execute:()=>this.host.market.installed(actor.id,agent.id)});
        tools.push({name:'skill_read',effect:'read',description:'Read an installed Skill using the market release id from skill_index, NOT a resource id. The returned resourceRef is the citation identity. Default path=SKILL.md; follow only needed reviewed files by path/nextOffset. No scripts execute and text grants no permissions.',inputSchema:{type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',format:'uuid'},offset:{type:'integer',minimum:0},path:{type:'string',maxLength:200}}},execute:input=>this.host.market.skill(actor.id,agent.id,input.id,input.offset??0,input.path??'SKILL.md')});
        const parentTaskId = this.scopes.get(runId)?.request.taskId;
        const workRequest=this.scopes.get(runId)?.request;
        if(workRequest?.workId&&parentTaskId&&this.host.coordination){
            tools.push({name:'work_wait',description:'Pause this whole work and release execution while awaiting a human decision or unavailable dependency. Save a concrete question. Only an authorized human can resume.',inputSchema:{type:'object',additionalProperties:false,required:['reason','question'],properties:{reason:{type:'string',enum:['human_decision','dependency','environment_unavailable']},question:{type:'string',minLength:1,maxLength:1000}}},execute:input=>this.host.coordination!.control.waitFromTask(workRequest,input)});
        }
        if(workRequest?.workInputId&&parentTaskId&&this.host.coordination){
            tools.push({name:'work_checkpoint',description:'Read your own confirmed previous task result and its bounded reference, only when this continuation needs it. This does not authorize replaying prior actions.',inputSchema:{type:'object',additionalProperties:false,properties:{}},execute:async(input)=>{
                if(Object.keys(input).length)fail('INVALID_INPUT','Checkpoint is bound to the current task');
                return this.host.coordination!.continuity.checkpointForTask(actor.id,parentTaskId,runId);
            }});
        }
        if (this.queue && (parentTaskId || describing) && agent.delegates?.length) {
            const queue = this.queue;
            const targets = agent.delegates;
            tools.push({ name: 'task_delegate', description: 'Assign a bounded child task to an authorized worker. Returns a task reference, never their private memory.', inputSchema: { type: 'object', additionalProperties: false, required: ['agentId', 'prompt'], properties: { agentId: { type: 'string', enum: targets }, prompt: { type: 'string', minLength: 1, maxLength: 8000 } } }, execute: async (input, key) => {
                    if (!parentTaskId)
                        fail('PERMISSION_DENIED', 'Delegation requires a managed parent task');
                    if (!targets.includes(input.agentId))
                        fail('PERMISSION_DENIED', 'Delegation target is not granted');
                    const current = await this.host.authorize(actor.id, agent.id);
                    if (!current.agent.delegates?.includes(input.agentId))
                        fail('PERMISSION_DENIED', 'Delegation grant was revoked');
                    const parent = await queue.get(parentTaskId, actor.id);
                    if (parent.parentTaskId)
                        fail('PERMISSION_DENIED', 'Delegation depth exceeds one');
                    return queue.submit({ principalId: actor.id, agentId: input.agentId, prompt: input.prompt, idempotencyKey: key, parentTaskId });
                } });
            tools.push({ name: 'task_status', description: 'Read a child task state and a short result summary.', inputSchema: { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: { type: 'string', format: 'uuid' } } }, execute: async (input) => {
                    if (!parentTaskId)
                        fail('PERMISSION_DENIED', 'Delegation requires a managed parent task');
                    const task = await queue.get(input.taskId, actor.id);
                    if (task.parentTaskId !== parentTaskId)
                        fail('PERMISSION_DENIED', 'Task is not a direct child');
                    return { id: task.id, agentId: task.agentId, state: task.state, summary: task.result?.summary??task.output?.slice(0, 2000), result:task.result,runId: task.runId, error: task.error };
                } });
        }
        return tools;
    }
    async run(request: RunRequest) {
        const job = this.execute(request);
        this.running.add(job);
        try {
            return await job;
        }
        finally {
            this.running.delete(job);
        }
    }
    async clientToolDescriptors(principalId: string, agentId: string) {
        const { actor, agent } = await this.host.authorize(principalId, agentId);
        return (await this.tools(actor, agent, '', true)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    }
    async openClientTurn(request: RunRequest) {
        const admitted = await this.admit(request);
        if ('prior' in admitted)
            fail('CONFLICT', 'Client turn was already admitted');
        const { scope, actor, agent } = admitted;
        scope.external = true;
        scope.contextRefs = request.initialContextRefs;
        try {
            scope.tools = await this.tools(actor, agent, scope.id);
        }
        catch (error) {
            await this.finishClientTurn(scope.id, '', 'CLIENT_SETUP_FAILED');
            throw error;
        }
        return { id: scope.id, token: scope.token, tools: scope.tools.map(t => t.name) };
    }
    async finishClientTurn(id: string, output: string, errorCode?: string) {
        const scope = this.scopes.get(id);
        if (!scope)
            return;
        if (scope.finishing)
            return scope.finishing;
        scope.finishing = (async () => {
            await this.drainOperations(scope);
            const state = scope.reconcile || errorCode === 'RESULT_UNKNOWN' ? 'reconciliation_required' : scope.cancelled ? 'cancelled' : scope.approvalRequired ? 'waiting_approval' : errorCode ? 'failed' : 'succeeded';
            try{
            await this.host.db.pool.query("UPDATE runs SET state=$2,data=data||$3::jsonb,updated_at=now() WHERE id=$1 AND state='running'", [id, state, JSON.stringify({ output: output.slice(0, 16000), source: 'harness-client', contextRefs: scope.contextRefs, ...(errorCode ? { error: { code: errorCode } } : {}) })]);
            if (scope.request.taskId) {
                const task=(await this.host.db.pool.query('SELECT * FROM tasks WHERE id=$1',[scope.request.taskId])).rows[0];
                if(task)await this.host.results.capture(task,{id,state,output:output.slice(0,16000),...(scope.report?{report:scope.report}:{})});
                await this.host.db.pool.query("UPDATE tasks SET state=$2,data=data||$3::jsonb,updated_at=now() WHERE id=$1 AND state='running'", [scope.request.taskId, state, JSON.stringify({ output: output.slice(0, 16000), runId: id, ...(errorCode ? { error: { code: errorCode } } : {}) })]);
            }
            await this.host.db.audit('run.' + state, { principalId: scope.request.principalId, agentId: scope.request.agentId, runId: id, source: 'harness-client', code: errorCode });
            }catch(error){
                await this.host.db.pool.query("UPDATE runs SET state='reconciliation_required',data=data||$2::jsonb,updated_at=now() WHERE id=$1",[id,JSON.stringify({error:{code:'RESULT_UNKNOWN'}})]);
                if(scope.request.taskId)await this.host.db.pool.query("UPDATE tasks SET state='reconciliation_required',data=data||$2::jsonb,updated_at=now() WHERE id=$1",[scope.request.taskId,JSON.stringify({error:{code:'RESULT_UNKNOWN'}})]);
                throw new FrameworkError('RESULT_UNKNOWN','Native result could not be persisted; completed actions were retained and will not be replayed');
            }finally{this.scopes.delete(id);}
        })();
        return scope.finishing;
    }
    async cancelClientTurn(id: string) {
        const scope = this.scopes.get(id);
        if (!scope?.external)
            return { accepted: false };
        scope.cancelled = true;
        scope.modelAbort?.abort();
        await this.host.db.audit('run.cancellation_requested', { principalId: scope.request.principalId, agentId: scope.request.agentId, runId: id, accepted: true, source: 'harness-client' });
        return { accepted: true };
    }
    private async drainOperations(scope: Scope) {
        while (scope.pendingOperations?.size)
            await Promise.allSettled([...scope.pendingOperations]);
    }
    private async admit(request: RunRequest): Promise<{
        prior: any;
    } | {
        actor: Actor;
        agent: Agent;
        id: string;
        scope: Scope;
    }> {
        if (this.closed)
            fail('UNAVAILABLE', 'Runtime is stopping');
        const { actor, agent } = await this.host.authorize(request.principalId, request.agentId);
        if (request.expectedAgentRevision && contentHash(agent) !== request.expectedAgentRevision)
            fail('CONFLICT', 'Refresh the changed company agent connection');
        if (!request.prompt || request.prompt.length > 8000 || !request.idempotencyKey || request.idempotencyKey.length > 160)
            fail('INVALID_INPUT', 'Invalid task');
        if (agent.runtime !== 'remote' && !await this.host.channels.hasModel(actor.id, this.options.model ?? 'deepseek-flash'))
            fail('PROVIDER_UNAVAILABLE', 'Configure an enabled model channel');
        const requestKey = hash(JSON.stringify([actor.id, agent.id, request.idempotencyKey]));
        const inputHash = hash(request.prompt);
        const prior = (await this.host.db.pool.query('SELECT * FROM runs WHERE request_key=$1', [requestKey])).rows[0];
        if (prior) {
            if (prior.data.inputHash !== inputHash)
                fail('CONFLICT', 'Task key reused with a changed prompt');
            return { prior: await this.get(prior.id, actor.id) };
        }
        const id = randomUUID();
        const client = await this.host.db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [this.host.db.schema + ':admission']);
            await this.host.coordination?.control.guard(request,client);
            const current = (await client.query('SELECT data FROM agents WHERE id=$1 FOR UPDATE', [agent.id])).rows[0].data as Agent;
            if (JSON.stringify(current) !== JSON.stringify(agent))
                fail('CONFLICT', 'Agent changed during run admission');
            const count = (await client.query("SELECT count(*)::int AS n FROM runs WHERE state='running'")).rows[0].n;
            if (count >= (this.options.maxConcurrentRuns ?? 3))
                throw new AdmissionBusyError('BUDGET_EXCEEDED', 'Host concurrent run capacity is occupied');
            if (request.clientSessionId && request.clientConnectionId) {
                request.taskId = randomUUID();
                request.budgetGroupId = request.taskId;
                await client.query('INSERT INTO tasks(id,agent_id,principal_id,state,request_key,input_hash,data) VALUES($1,$2,$3,$4,$5,$6,$7)', [request.taskId, agent.id, actor.id, 'running', 'native:' + requestKey, inputHash, JSON.stringify({ resultFormat:'references-v1',prompt: request.prompt, source: 'harness-client', clientSessionId: request.clientSessionId, clientConnectionId: request.clientConnectionId, executionPrincipalId: actor.id })]);
            }
            await client.query('INSERT INTO runs(id,agent_id,principal_id,state,data,request_key) VALUES($1,$2,$3,$4,$5,$6)', [id, agent.id, actor.id, 'running', JSON.stringify({ resultFormat:'references-v1',inputHash, pluginId: agent.pluginId, pluginVersion: agent.pluginVersion, preset: agent.preset, taskId: request.taskId,contextWorkId:request.contextWorkId,executionProfile:request.executionProfile,workId:request.workId,workRound:request.workRound,workInputId:request.workInputId }), requestKey]);
            if (request.taskId)
                await client.query('UPDATE tasks SET data=data||$2::jsonb WHERE id=$1', [request.taskId, JSON.stringify({ runId: id })]);
            await client.query('COMMIT');
        }
        catch (e) {
            await client.query('ROLLBACK');
            if ((e as any).code === '23505' && (e as any).constraint === 'runs_one_active_agent')
                throw new AdmissionBusyError('CONFLICT', 'Agent is processing another task');
            if ((e as {
                code?: string;
            }).code === '23505')
                fail('CONFLICT', 'Agent has an active task or duplicate admission; query task state');
            throw e;
        }
        finally {
            client.release();
        }
        await this.budget.open(request.budgetGroupId ?? id);
        const token = 'fw_run_' + randomBytes(32).toString('base64url');
        const scope: Scope = { id, request, token, tools: [], calls: 0, expiresAt: Date.now() + 180000, metadata: { companyId: agent.companyId, initiatingPrincipalId: request.initiatingPrincipalId ?? actor.id, taskId: request.taskId ?? null,workId:request.workId??null,workRound:request.workRound??null,workInputId:request.workInputId??null, bindings: this.host.bindings(agent).map(b => ({ pluginId: b.pluginId, pluginVersion: b.pluginVersion })) } };
        this.scopes.set(id, scope);
        await this.host.db.audit('run.started', { principalId: actor.id, agentId: agent.id, runId: id, inputHash });
        return { actor, agent, id, scope };
    }
    private async execute(request: RunRequest): Promise<any> {
        const admitted = await this.admit(request);
        if ('prior' in admitted)
            return admitted.prior;
        const { actor, agent, id, scope } = admitted;
        const { token } = scope;
        try {
            await this.host.coordination?.control.guardRun(id);
            scope.tools = await this.tools(actor, agent, id);
            if(request.executionProfile==='memory-maintenance')scope.tools=scope.tools.filter(t=>['resource_index','resource_read','resource_recall','memory_read','work_memory_read','work_memory_rebuild'].includes(t.name));
            await this.host.coordination?.control.guardRun(id);
            if (scope.cancelled)
                fail('CANCELLED', 'Task cancelled before execution');
            let result: {
                sessionId: string;
                finishReason: string | null;
                finalResponse: string;
                events: unknown[];
            };
            let contextRefs: unknown[] = [];
            if (agent.runtime === 'remote') {
                const connection = this.host.options.connections?.[agent.connectionRef ?? ''];
                if (!connection)
                    fail('UNAVAILABLE', 'Remote agent connection is not configured');
                const remote = new RemoteAgentAdapter(connection);
                scope.remote = remote;
                const origin = this.app.listeningOrigin;
                const remoteResult = await remote.run(request.prompt, { companyId: agent.companyId, principalId: actor.id, agentId: agent.id, runId: id, pluginId: agent.pluginId, pluginVersion: agent.pluginVersion, gateway: { modelURL: origin + '/internal/model/' + id, mcpURL: origin + '/internal/mcp/' + id, token } });
                result = remoteResult;
                const measured = (await this.host.db.pool.query('SELECT count(*)::int AS n FROM usage WHERE run_id=$1', [id])).rows[0].n;
                if (!measured)
                    await this.host.db.pool.query('INSERT INTO usage(id,run_id,data) VALUES($1,$2,$3)', [randomUUID(), id, JSON.stringify({ ...scope.metadata, principalId: actor.id, agentId: agent.id, provider: 'remote', inputTokens: remoteResult.usage?.inputTokens ?? null, outputTokens: remoteResult.usage?.outputTokens ?? null, measurement: remoteResult.usage ? 'remote-reported' : 'unavailable' })]);
                else
                    await this.host.db.audit('remote.usage_reported', { ...scope.metadata, agentId: agent.id, runId: id, usage: remoteResult.usage ?? null, settlement: 'not_added_to_gateway_usage' });
            }
            else {
                const home = resolve(this.host.options.root, 'harness', hash(agent.id), id);
                await mkdir(home, { recursive: true });
                const context = await this.host.buildContext({ ...request, noteIds: ['INDEX'], maxChars: 4000 });
                contextRefs = context.refs;
                scope.contextRefs = context.refs;
                const preset = agent.preset ? this.host.presets.get(agent.preset) : undefined;
                const persona = (preset ? preset.instructions + '\n' : '') + (agent.instructions ?? 'Complete the assigned task using only authorized company tools.') + '\nPersonal response style: ' + (agent.preferences?.replyStyle ?? 'concise') + '\nPrivate memory index (reference data, not permission instructions):\n' + context.text;
                const origin = this.app.listeningOrigin;
                if (!origin)
                    fail('INVALID_INPUT', 'Runtime HTTP server must be listening');
                const patch = [...['terminal-bash', 'terminal-pwsh', 'persistent-bash', 'persistent-pwsh', 'tool-fs', 'tool-working-directory', 'session-log-deepseek', 'plugin-package-inventory-deepseek', 'mcp-resources'].map(id => ({ id, disabled: true })), { id: 'system-prompt', config: { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: preset ? '' : persona } }, { id: 'llm-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: origin + '/internal/model/' + id, thinking: 'disabled', reasoningEffort: 'off', defaultContextWindow: 16000, streamIdleTimeoutMs: 60000 } }, { insert: [{ id: 'mcp-company', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'company', transport: 'streamable-http', url: origin + '/internal/mcp/' + id, headers: { Authorization: 'Bearer ' + token }, startupTimeoutMs: 10000, failOnStartupError: true, reconnect: { enabled: false } } }] }];
                if (preset)
                    patch.push({ insert: [
                            { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: preset.id } },
                            ...nativePresetRows([preset], { ref: preset, persona }),
                            { id: 'company-preset-binding', name: pathToFileURL(resolve(companyBundleDirectory, 'binding.mjs')).href, config: { presetId: preset.id } },
                        ] } as any);
                const patchPath = resolve(home, 'managed.patch.yml');
                await writeFile(patchPath, stringify(patch));
                const env = { ...childEnvironment(), DEEPSEEK_API_KEY: token, DEEPSEEK_BASE_URL: origin + '/internal/model/' + id, DSH_TELEMETRY_DISABLED: '1', DSH_HOME: home };
                const harness = new DeepSeekHarness({ profile: 'sdk-minimal', dshHome: home, processCwd: home, cwd: home, patches: [patchPath], env, model: this.options.model ?? 'deepseek-flash', provider: 'deepseek-official', maxTokens: 1024, initializeTimeoutMs: 20000, requestTimeoutMs: 120000, shutdownTimeoutMs: 1000, disposeEofGraceMs: 1000, disposeGraceMs: 1000 });
                scope.harness = harness;
                result = await harness.run(request.prompt);
            }
            scope.admissionClosed = true;
            await this.drainOperations(scope);
            await scope.workStop;
            if (scope.cancelled)
                fail('CANCELLED', 'Cancellation completed; prior side effects remain recorded');
            if (scope.reconcile)
                fail('RESULT_UNKNOWN', 'A tool outcome needs reconciliation');
            if (scope.approvalRequired)
                fail('APPROVAL_REQUIRED', 'A write operation is waiting for administrator approval');
            if (result.finishReason === 'error' || result.finishReason === 'aborted' || !result.finalResponse)
                fail('RUNTIME_FAILED', 'Harness did not produce a successful final response');
            const settled=await this.host.db.pool.query("UPDATE runs SET state='succeeded',data=data||$2::jsonb,updated_at=now() WHERE id=$1 AND state='running'", [id, JSON.stringify({ output: result.finalResponse.slice(0, 16000), ...(scope.report?{report:scope.report}:{}), sessionId: result.sessionId, finishReason: result.finishReason, eventCount: result.events.length, contextRefs })]);
            await this.host.db.audit(settled.rowCount?'run.succeeded':'run.late_result', { principalId: actor.id, agentId: agent.id, runId: id, sessionId: result.sessionId, finishReason: result.finishReason, eventCount: result.events.length });
        }
        catch (error) {
            scope.admissionClosed = true;
            await this.drainOperations(scope);
            await scope.workStop;
            if (scope.cancelled && scope.harness) {
                try {
                    await scope.harness.close();
                }
                catch {
                    scope.cancelled = false;
                    scope.reconcile = true;
                }
            }
            const uncertain=scope.reconcile||['RESULT_UNKNOWN','TIMEOUT','PLUGIN_EXITED'].includes((error as any).code)||(error as Error).name==='RequestTimeoutError';
            const code = uncertain ? 'RESULT_UNKNOWN' : scope.cancelled ? 'CANCELLED' : (error as {
                code?: string;
            }).code ?? 'RUNTIME_FAILED';
            const state = code === 'CANCELLED' ? 'cancelled' : code === 'APPROVAL_REQUIRED' ? 'waiting_approval' : scope.reconcile || ['RESULT_UNKNOWN', 'TIMEOUT', 'PLUGIN_EXITED'].includes(code) || (error as Error).name === 'RequestTimeoutError' ? 'reconciliation_required' : 'failed';
            await this.host.db.pool.query("UPDATE runs SET state=$3,data=data||$2::jsonb,updated_at=now() WHERE id=$1 AND state='running'", [id, JSON.stringify({ error: { code } }), state]);
            await this.host.db.audit('run.' + state, { principalId: actor.id, agentId: agent.id, runId: id, code });
            if(uncertain)fail('RESULT_UNKNOWN','The previous execution could not be confirmed stopped');
            if (scope.cancelled)
                fail('CANCELLED', 'Task execution stopped; completed effects are retained');
            throw error;
        }
        finally {
            this.scopes.delete(id);
            await scope.harness?.close();
        }
        return this.get(id, actor.id);
    }
    async get(id: string, principalId: string) {
        if (!/^[0-9a-f-]{36}$/u.test(id))
            fail('INVALID_INPUT', 'Invalid run id');
        const row = (await this.host.db.pool.query('SELECT * FROM runs WHERE id=$1', [id])).rows[0];
        if (!row)
            fail('NOT_FOUND', 'Run does not exist');
        await this.host.authorize(principalId, row.agent_id, 'read');
        const result=row.data.taskId?await this.host.results.view(principalId,row.data.taskId):null;
        const data={...row.data};if(result&&!result.processAvailable||!result&&principalId!==row.principal_id){delete data.output;delete data.report;}
        return { id: row.id, agentId: row.agent_id, principalId: row.principal_id, state: row.state, ...data, ...(result?{result}:{}),createdAt: row.created_at, updatedAt: row.updated_at };
    }
    async cancel(id: string, principalId: string) {
        const run = await this.get(id, principalId);
        await this.host.authorize(principalId, run.agentId);
        if (run.state !== 'running')
            return { accepted: false, state: run.state };
        const scope = this.scopes.get(id);
        if (!scope)
            fail('RESULT_UNKNOWN', 'Runtime owner is unavailable; reconcile first');
        await this.host.db.pool.query('UPDATE runs SET data=data||$2::jsonb WHERE id=$1', [id, JSON.stringify({ cancellationRequested: true })]);
        if (scope.remote) {
            try {
                const result = await scope.remote.cancel();
                scope.cancellationAccepted = result.accepted;
                await this.host.db.audit('run.cancellation_requested', { principalId, agentId: run.agentId, runId: id, accepted: result.accepted });
                return { ...result, final: false, sideEffects: 'Poll run state for terminal confirmation; completed actions are not undone' };
            }
            catch (error) {
                scope.reconcile = true;
                scope.expiresAt = 0;
                throw error;
            }
        }
        scope.cancelled = true;
        scope.modelAbort?.abort();
        try {
            await scope.harness?.close();
        }
        catch (error) {
            scope.cancelled = false;
            scope.reconcile = true;
            throw error;
        }
        await this.host.db.audit('run.cancellation_requested', { principalId, agentId: run.agentId, runId: id, accepted: true });
        return { accepted: true, final: false, sideEffects: 'Poll run state; completed external actions are not undone' };
    }
    async stopWork(workId:string){
        const scopes=[...this.scopes.values()].filter(scope=>scope.request.workId===workId);
        await Promise.allSettled(scopes.map(async scope=>{
            scope.admissionClosed=true;scope.cancelled=true;scope.modelAbort?.abort();
            scope.workStop??=(async()=>{try{if(scope.remote){const result=await scope.remote.cancel();if(!result.accepted)scope.reconcile=true;}else await scope.harness?.close();}catch{scope.reconcile=true;}})();
            await scope.workStop;
            if(scope.external)await this.finishClientTurn(scope.id,'','CANCELLED');
        }));
    }
    async usage(request: {
        principalId: string;
        agentId: string;
    }) {
        await this.host.authorize(request.principalId, request.agentId, 'read');
        const rows = (await this.host.db.pool.query("SELECT run_id,data FROM usage WHERE data->>'agentId'=$1 ORDER BY created_at DESC LIMIT 1000", [request.agentId])).rows.map(r => ({ runId: r.run_id, ...r.data }));
        const totals = (await this.host.db.pool.query("SELECT count(*)::int AS requests,coalesce(sum((data->>'inputTokens')::bigint),0)::text AS input_tokens,coalesce(sum((data->>'outputTokens')::bigint),0)::text AS output_tokens,count(*) FILTER(WHERE data->>'measurement'='unavailable')::int AS unmeasured FROM usage WHERE data->>'agentId'=$1", [request.agentId])).rows[0];
        return { agentId: request.agentId, requests: totals.requests, inputTokens: Number(totals.input_tokens), outputTokens: Number(totals.output_tokens), unmeasuredRequests: totals.unmeasured, priceStatus: 'unconfigured', recordsLimit: 1000, records: rows };
    }
    async recoverInterrupted() {
        const result = await this.host.db.pool.query("UPDATE runs SET state='reconciliation_required',updated_at=now() WHERE state='running' RETURNING id,agent_id,principal_id");
        for (const r of result.rows)
            await this.host.db.audit('run.interrupted', { runId: r.id, agentId: r.agent_id, principalId: r.principal_id });
        return result.rowCount;
    }
    async close() {
        this.closed = true;
        for (const scope of this.scopes.values()) {
            scope.expiresAt = 0;
            if (scope.remote) {
                await scope.remote.cancel().catch(() => { });
                scope.remote.stopMonitoring();
                scope.reconcile = true;
            }
            else {
                scope.cancelled = true;
                scope.modelAbort?.abort();
                await scope.harness?.close();
                if (scope.external)
                    await this.finishClientTurn(scope.id, '', 'CLIENT_CLOSED');
            }
        }
        await Promise.allSettled([...this.running]);
    }
}
