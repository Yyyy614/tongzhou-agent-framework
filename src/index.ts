import { PluginRegistry } from './plugins/registry.js';
import { Database } from './persistence.js';
import { fail, ActionNotStartedError, FrameworkError } from './errors.js';
import { PluginWorker } from './plugins/worker.js';
import { RemotePeer, type RpcPeer } from './plugins/remote.js';
import type { Actor, Agent, Invocation, Receipt, PluginBinding } from './types.js';
import type { PoolConfig, PoolClient } from 'pg';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MemoryStore } from './memory.js';
import type { MemoryRequest, MemoryWrite, ContextRequest } from './types.js';
import { contentHash } from './contracts.js';
import { PresetCatalog } from './presets.js';
import { Organization } from './organization.js';
import { Channels } from './channels.js';
import { workBody, type WorkCoordinator } from './work.js';
import { reminderBody, type WorkAssistant } from './assistant.js';
import type{EntryConnections,EntryTransportFactory}from'./entry-connections.js';
export { FrameworkError } from './errors.js';
export type { Actor, Agent, Invocation, Receipt } from './types.js';
export type { WorkInput, WorkInputReceipt, WorkEntry } from './work-continuity.js';
export type { WorkControlRequest, WorkReconciliation } from './work-control.js';
export interface FrameworkOptions {
    entries?:boolean;
    publicOrigin?:string;
    entryTransportFactory?:EntryTransportFactory;
    entryQrFetch?:typeof fetch;
    presetDirectories?: string[];
    root: string;
    database?: PoolConfig;
    connections?: Record<string, {
        url: string;
        token?: string;
    }>;
}
export class Framework {
    readonly presets = new PresetCatalog();
    readonly registry: PluginRegistry;
    readonly db: Database;
    private workers = new Map<string, Promise<RpcPeer>>();
    private scopes = new Map<string, {
        request: Invocation;
        workerKey: string;
    }>();
    readonly memory: MemoryStore;
    readonly organization: Organization;
    readonly channels: Channels;
    coordination?: WorkCoordinator;
    assistant?: WorkAssistant;
    entries?:EntryConnections;
    constructor(readonly options: FrameworkOptions) {
        this.registry = new PluginRegistry(options.root);
        this.db = new Database(options.root, options.database);
        this.organization = new Organization(this);
        this.channels = new Channels(this);
        this.memory = new MemoryStore(options.root, this.db, (p,a,action)=>this.authorizeMemory(p,a,action));
    }
    async authorizeMemory(principalId:string,agentId:string,action:'read'|'execute',client?:Pick<PoolClient,'query'>){
        const scope=await this.authorize(principalId,agentId,action,client);
        if(scope.actor.id!==scope.agent.ownerId&&scope.actor.role!=='admin'&&!scope.actor.permissions.includes('memory.'+action+':'+agentId))fail('PERMISSION_DENIED','Work visibility does not grant private memory access');
        return scope;
    }
    async installPlugin(path: string,principalId?:string) {const actor=principalId?await this.db.get<Actor>('actors',principalId):undefined;if(actor&&(!actor.active||actor.role!=='admin'))fail('PERMISSION_DENIED','Only administrators install packages');const p = await this.registry.install(path); await this.db.audit('plugin.installed', {principalId:actor?.id,companyId:actor?.companyId, pluginId: p.id, version: p.version, digest: p.digest }); return p; }
    async listTools() { return this.registry.tools(); }
    async approveTool(request: {
        principalId: string;
        targetPrincipalId: string;
        agentId: string;
        toolRef: string;
        input: unknown;
        reason: string;
    }) {
        const { actor, agent } = await this.authorize(request.principalId, request.agentId);
        if (actor.role !== 'admin' || !request.reason || request.reason.length > 1000)
            fail('PERMISSION_DENIED', 'Administrator and approval reason are required');
        await this.authorize(request.targetPrincipalId, agent.id);
        const plugin = this.pluginFor(agent, request.toolRef);
        const tool = plugin.manifest.provides.tools.find(t => plugin.id + ':' + t.id === request.toolRef);
        if (!tool || tool.effect !== 'write')
            fail('INVALID_INPUT', 'Approval target must be a declared write tool');
        await this.registry.validateTool(plugin, tool, request.input);
        const id = randomUUID();
        await this.db.pool.query("INSERT INTO approvals(id,principal_id,agent_id,tool_ref,plugin_version,input_hash,approved_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '15 minutes')", [id, request.targetPrincipalId, agent.id, request.toolRef, plugin.version, contentHash(request.input), actor.id]);
        await this.db.audit('approval.granted', { approvalId: id, principalId: actor.id, targetPrincipalId: request.targetPrincipalId, agentId: agent.id, toolRef: request.toolRef, inputHash: contentHash(request.input), reason: request.reason });
        return { approvalId: id, expiresInSeconds: 900 };
    }
    bindings(agent: Agent): PluginBinding[] { return [{ pluginId: agent.pluginId, pluginVersion: agent.pluginVersion, config: agent.config }, ...(agent.plugins ?? [])]; }
    pluginFor(agent: Agent, toolRef: string) {
        const binding = this.bindings(agent).find(p => toolRef.startsWith(p.pluginId + ':'));
        if (!binding)
            fail('PERMISSION_DENIED', 'Tool plugin is not mounted on agent');
        return this.registry.get(binding.pluginId, binding.pluginVersion);
    }
    async releaseAgent(request: {
        principalId: string;
        agentId: string;
        pluginId?: string;
        pluginVersion: string;
        reason: string;
    }) {
        const { actor, agent } = await this.authorize(request.principalId, request.agentId);
        if (actor.role !== 'admin')
            fail('PERMISSION_DENIED', 'Only administrators publish versions');
        if (!request.reason || request.reason.length > 1000)
            fail('INVALID_INPUT', 'A release reason is required');
        const binding = this.bindings(agent).find(b => b.pluginId === (request.pluginId ?? agent.pluginId));
        if (!binding)
            fail('INVALID_INPUT', 'Target plugin is not mounted');
        const plugin = this.registry.get(binding.pluginId, request.pluginVersion);
        await this.validatePlugin(plugin.id, plugin.version, binding.config ?? {}, agent.ownerId);
        const declared = new Set(plugin.manifest.provides.tools.map(t => plugin.id + ':' + t.id));
        if (agent.allowedTools.some(t => t.startsWith(plugin.id + ':') && !declared.has(t)))
            fail('CONFLICT', 'Candidate removes a granted tool');
        const client = await this.db.pool.connect();
        try {
            await client.query('BEGIN');
            const current = (await client.query('SELECT data FROM agents WHERE id=$1 FOR UPDATE', [agent.id])).rows[0].data as Agent;
            if (JSON.stringify(current) !== JSON.stringify(agent))
                fail('CONFLICT', 'Agent changed during candidate validation');
            const active = (await client.query("SELECT count(*)::int AS n FROM runs WHERE agent_id=$1 AND state='running'", [agent.id])).rows[0].n;
            if (active || [...this.scopes.values()].some(s => s.request.agentId === agent.id))
                fail('CONFLICT', 'Drain active executions before publishing');
            const next = plugin.id === agent.pluginId ? { ...agent, pluginVersion: plugin.version } : { ...agent, plugins: agent.plugins?.map(b => b.pluginId === plugin.id ? { ...b, pluginVersion: plugin.version } : b) };
            await client.query('UPDATE agents SET data=$2 WHERE id=$1', [agent.id, JSON.stringify(next)]);
            const evidenceRef = randomUUID();
            await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [evidenceRef, 'release.applied', JSON.stringify({ principalId: actor.id, agentId: agent.id, pluginId: plugin.id, fromVersion: binding.pluginVersion, toVersion: plugin.version, digest: plugin.digest, reason: request.reason })]);
            await client.query('COMMIT');
            return { agentId: agent.id, pluginVersion: plugin.version, evidenceRef };
        }
        catch (e) {
            await client.query('ROLLBACK');
            throw e;
        }
        finally {
            client.release();
        }
    }
    async resolveConnection(reference: string, principalId?: string) { return (principalId ? await this.channels.resolveConnection(principalId, reference) : null) ?? this.options.connections?.[reference]; }
    async validatePlugin(id: string, version: string, config: Record<string, unknown> = {}, principalId?: string) {
        const plugin = this.registry.get(id, version);
        const schema = JSON.parse(await readFile(await this.registry.packagePath(plugin.directory, plugin.manifest.configSchema), 'utf8'));
        if (!this.registry.ajv.validate(schema, config))
            fail('INVALID_INPUT', 'Candidate configuration does not satisfy schema');
        let peer: RpcPeer;
        let params: unknown;
        if (plugin.manifest.entry.kind === 'remote') {
            const connection = await this.resolveConnection(plugin.manifest.entry.connectionRef, principalId);
            if (!connection)
                fail('UNAVAILABLE', 'Remote connection is not configured');
            peer = new RemotePeer(connection);
            params = { protocol: '1.0', pluginId: id, version, config };
        }
        else {
            const cwd = resolve(this.options.root, 'validation', plugin.digest);
            await mkdir(cwd, { recursive: true });
            peer = new PluginWorker(cwd, async () => fail('PERMISSION_DENIED', 'Validation does not grant host services'));
            params = { protocol: '1.0', entry: await this.registry.packagePath(plugin.directory, plugin.manifest.entry.path), config };
        }
        try {
            const initialized = await peer.call('plugin.initialize', params);
            if (initialized.protocol !== '1.0' || JSON.stringify([...initialized.tools].sort()) !== JSON.stringify(plugin.manifest.provides.tools.map(t => t.id).sort()))
                fail('INVALID_PACKAGE', 'Candidate capability handshake failed');
            const health = await peer.call('plugin.health', {});
            if (health.status !== 'ready')
                fail('UNAVAILABLE', 'Candidate health check failed');
            return { status: 'validated', pluginId: id, version, digest: plugin.digest };
        }
        finally {
            await peer.close();
        }
    }
    async setPluginEnabled(request: {
        principalId: string;
        pluginId: string;
        version: string;
        enabled: boolean;
    }) {
        const actor = await this.db.get<Actor>('actors', request.principalId);
        if (!actor.active || actor.role !== 'admin')
            fail('PERMISSION_DENIED', 'Only administrators manage plugins');
        await this.registry.setEnabled(request.pluginId, request.version, request.enabled);
        await this.db.audit('plugin.enabled_changed', request);
    }
    async personalize(request: {
        principalId: string;
        agentId: string;
        replyStyle: string;
    }) {
        const { actor, agent } = await this.authorize(request.principalId, request.agentId);
        if (actor.id !== agent.ownerId || typeof request.replyStyle !== 'string' || request.replyStyle.length > 1500)
            fail('PERMISSION_DENIED', 'Only the owner may edit bounded personal preferences');
        const updated = await this.db.pool.query("UPDATE agents SET data=jsonb_set(data,'{preferences}',$2::jsonb) WHERE id=$1 AND data->>'ownerId'=$3 AND data->>'active'='true' RETURNING id", [agent.id, JSON.stringify({ replyStyle: request.replyStyle }), actor.id]);
        if (!updated.rowCount)
            fail('PERMISSION_DENIED', 'Agent ownership or activation changed');
        await this.db.audit('preferences.updated', { principalId: actor.id, agentId: agent.id });
        return { replyStyle: request.replyStyle };
    }
    async feedback(request: {
        principalId: string;
        agentId: string;
        message: string;
        runId?: string;
    }) {
        const { actor, agent } = await this.authorize(request.principalId, request.agentId);
        if (!request.message || request.message.length > 4000)
            fail('INVALID_INPUT', 'Invalid feedback');
        if (request.runId) {
            const run = (await this.db.pool.query('SELECT agent_id FROM runs WHERE id=$1', [request.runId])).rows[0];
            if (!run || run.agent_id !== agent.id)
                fail('PERMISSION_DENIED', 'Feedback run must belong to agent');
        }
        return { evidenceRef: await this.db.audit('feedback.recorded', { ...request, pluginId: agent.pluginId, pluginVersion: agent.pluginVersion }) };
    }
    async reportSummary(request: {
        principalId: string;
        agentId: string;
    }) { await this.authorize(request.principalId, request.agentId, 'read'); const runs = (await this.db.pool.query('SELECT state,count(*)::int AS count FROM runs WHERE agent_id=$1 GROUP BY state', [request.agentId])).rows; const reports = (await this.db.pool.query("SELECT id,type,data,created_at FROM audit WHERE data->>'agentId'=$1 AND type IN ('report.recorded','feedback.recorded','release.applied') ORDER BY seq DESC LIMIT 100", [request.agentId])).rows; return { agentId: request.agentId, runs, reports }; }
    async issueAccessToken(principalId: string) {
        const actor = await this.db.get<Actor>('actors', principalId);
        if (!actor.active)
            fail('UNAUTHENTICATED', 'Actor is inactive');
        const token = 'fw_auth_' + randomBytes(32).toString('base64url');
        await this.db.pool.query("INSERT INTO access_tokens(hash,principal_id,expires_at) VALUES($1,$2,now()+interval '30 days')", [createHash('sha256').update(token).digest('hex'), principalId]);
        return token;
    }
    async authenticate(token: string) {
        if (typeof token !== 'string' || token.length > 256)
            fail('UNAUTHENTICATED', 'Invalid access token');
        const row = (await this.db.pool.query('SELECT principal_id FROM access_tokens WHERE hash=$1 AND expires_at>now()', [createHash('sha256').update(token).digest('hex')])).rows[0];
        if (!row)
            fail('UNAUTHENTICATED', 'Invalid access token');
        const actor = await this.db.get<Actor>('actors', row.principal_id);
        if (!actor.active)
            fail('UNAUTHENTICATED', 'Actor is inactive');
        return actor;
    }
    async revokeAccessToken(token: string) { await this.db.pool.query('DELETE FROM access_tokens WHERE hash=$1', [createHash('sha256').update(token).digest('hex')]); }
    async writeMemory(request: MemoryWrite) { return this.memory.write(request); }
    async readMemory(request: MemoryRequest) { return this.memory.read(request); }
    async buildContext(request: ContextRequest) { return this.memory.context(request); }
    async listLogs(request: {
        principalId: string;
        agentId: string;
        limit?: number;
    }) {
        await this.authorize(request.principalId, request.agentId, 'read');
        const limit = request.limit ?? 100;
        if (!Number.isInteger(limit) || limit < 1 || limit > 500)
            fail('INVALID_INPUT', 'Invalid log limit');
        return (await this.db.pool.query("SELECT id,type,data,created_at FROM audit WHERE data->>'agentId'=$1 ORDER BY seq DESC LIMIT $2", [request.agentId, limit])).rows;
    }
    async recordReport(request: {
        principalId: string;
        agentId: string;
        summary: string;
        runId?: string;
    }) {
        await this.authorize(request.principalId, request.agentId);
        if (typeof request.summary !== 'string' || request.summary.length > 8000)
            fail('INVALID_INPUT', 'Invalid report');
        return { evidenceRef: await this.db.audit('report.recorded', request) };
    }
    async authorizeHostCapability(principalId: string, agentId: string, toolRef: string, permission: string, version?: string, client?: Pick<PoolClient, 'query'>) {
        const { actor, agent } = await this.authorize(principalId, agentId, 'execute', client);
        const plugin = this.pluginFor(agent, toolRef);
        const tool = plugin.manifest.provides.tools.find(t => plugin.id + ':' + t.id === toolRef);
        const legacy = plugin.manifest.schemaVersion === '0.1.0' && ['memory.self.read', 'memory.self.propose_write', 'report.self.write'].includes(permission);
        if ((version && plugin.version !== version) || !tool || !agent.allowedTools.includes(toolRef) || (actor.role !== 'admin' && !actor.permissions.includes('tool.invoke:' + toolRef)) || (!legacy && !tool.hostServices?.includes(permission)) || !plugin.manifest.permissions.includes(permission) || !agent.servicePermissions?.includes(permission) || (actor.role !== 'admin' && !actor.permissions.includes(permission))) fail('PERMISSION_DENIED', 'Host service is not in effective grants');
        return { actor, agent, plugin };
    }
    private async hostService(workerKey: string, method: string, params: any) {
        const scope = this.scopes.get(params?.invocationId);
        if (!scope || scope.workerKey !== workerKey)
            fail('PERMISSION_DENIED', 'Invocation scope is not active');
        const { request } = scope;
        if(request.runId)await this.coordination?.control.guardRun(request.runId);
        const permission = ({ 'memory.read': 'memory.self.read', 'memory.write': 'memory.self.propose_write', 'report.record': 'report.self.write', 'team.list': 'team.read', 'work.dispatch': 'work.dispatch', 'work.list': 'work.read', 'work.read': 'work.read', 'reminder.create': 'reminder.write', 'reminder.list': 'reminder.read', 'inbox.list': 'inbox.self.read', 'event.publish': 'event.self.publish', 'connection.catalog': 'connection.catalog.read' } as Record<string, string>)[method];
        if (!permission) fail('UNSUPPORTED_CAPABILITY', 'Unknown host service');
        const { actor, agent, plugin } = await this.authorizeHostCapability(request.principalId, request.agentId, request.toolRef, permission);
        const bound = { principalId: actor.id, agentId: agent.id };
        if (method === 'connection.catalog') {
            const available = (await this.channels.list(actor.id)).filter(c => c.enabled);
            if (params.id !== undefined) { const item = available.find(c => c.id === params.id); if (!item) fail('NOT_FOUND', 'Connection is not visible'); return { id: item.id, name: item.name, protocol: item.protocol, reference: 'connection:' + item.id, documentation: item.documentation, baseURL: item.baseURL, model: item.model }; }
            return { items: available.map(c => ({ id: c.id, name: c.name, kind: c.kind, protocol: c.protocol, reference: 'connection:' + c.id, excerpt: c.documentation.slice(0,240) })) };
        }
        if (method === 'memory.read')
            return this.readMemory({ ...bound, noteId: params.ref?.noteId });
        if (method === 'memory.write')
            return this.writeMemory({ ...params.entry, ...bound });
        if (method === 'report.record')
            return this.recordReport({ ...bound, runId: request.runId, summary: params.record?.summary });
        const source = { sourceAgentId: agent.id, sourceToolRef: request.toolRef, sourcePluginVersion: plugin.version };
        // A queued work result cannot start a second delegation tree. Share the originating turn budget.
        const run = request.runId ? (await this.db.pool.query('SELECT data FROM runs WHERE id=$1', [request.runId])).rows[0] : null;
        const task = run?.data.taskId ? (await this.db.pool.query('SELECT id,data FROM tasks WHERE id=$1', [run.data.taskId])).rows[0] : null;
        if (method === 'team.list') return this.organization.team(actor.id);
        if (method === 'work.dispatch') {
            if (!this.registry.ajv.validate(workBody, { ...params.input, idempotencyKey: 'host-bound' })) fail('INVALID_INPUT', 'Invalid work service input');
            if (!this.coordination) fail('UNAVAILABLE', 'Work queue is not available');
            if (task?.data.workId) fail('BUDGET_EXCEEDED', 'A work assignment cannot start another delegation tree');
            return this.coordination.create(actor.id, { ...params.input, ...source, idempotencyKey: 'plugin:' + params.invocationId, budgetGroupId: task?.data.budgetGroupId ?? task?.id });
        }
        if (method === 'work.list') return { items: await this.coordination?.list(actor.id) ?? [] };
        if (method === 'work.read') { if (!this.coordination) fail('UNAVAILABLE', 'Work queue is not available'); return this.coordination.get(actor.id, params.id); }
        if (!this.assistant) fail('UNAVAILABLE', 'Work assistant is not available');
        if (method === 'reminder.create') {
            if (!this.registry.ajv.validate(reminderBody, { ...params.input, agentId: params.input?.agentId ?? agent.id, idempotencyKey: 'host-bound' })) fail('INVALID_INPUT', 'Invalid reminder service input');
            return this.assistant.createReminder(actor.id, { ...params.input, agentId: params.input?.agentId ?? agent.id, ...source, idempotencyKey: 'plugin:' + params.invocationId });
        }
        if (method === 'reminder.list') return { items: await this.assistant.reminders(actor.id) };
        if (method === 'inbox.list') return { items: await this.assistant.inbox(actor.id) };
        if (method === 'event.publish') return this.assistant.publishEvent(actor.id, { ...params.input, agentId: agent.id, idempotencyKey: 'plugin:' + params.invocationId }, 'plugin:' + plugin.id, { noAutomation: !!task?.data.workId, originWorkId: task?.data.workId });
        fail('UNSUPPORTED_CAPABILITY', 'Unknown host service');
    }
    async putActor(actor: Actor) {
        const client = await this.db.pool.connect();
        try {
            await client.query('BEGIN'); await this.organization.lock(client);
            const next = { ...actor, active: actor.active !== false };
            await this.organization.validateActor(next, client);
            await client.query('INSERT INTO actors(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', [actor.id, JSON.stringify(next)]);
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    async putAgent(agent: Agent) {
        await this.validateAgent(agent);
        await this.db.put('agents', agent.id, { ...agent, active: agent.active !== false });
    }
    async validateAgent(agent: Agent) {
        if (agent.preset) this.presets.get(agent.preset);
        const owner = await this.db.get<Actor>('actors', agent.ownerId);
        if (owner.companyId !== agent.companyId)
            fail('PERMISSION_DENIED', 'Agent owner must belong to company');
        const bindings = this.bindings(agent);
        if (bindings.length > 16 || new Set(bindings.map(b => b.pluginId)).size !== bindings.length)
            fail('INVALID_INPUT', 'Plugin bindings must be unique and at most sixteen');
        for (const b of bindings) {
            const p = this.registry.get(b.pluginId, b.pluginVersion);
            const schema = JSON.parse(await readFile(await this.registry.packagePath(p.directory, p.manifest.configSchema), 'utf8'));
            if (!this.registry.ajv.validate(schema, b.config ?? {}))
                fail('INVALID_INPUT', 'Plugin config does not match schema');
        }
    }
    hasActiveInvocation(agentId: string) { return [...this.scopes.values()].some(scope => scope.request.agentId === agentId); }
    async authorize(principalId: string, agentId: string, action: 'execute' | 'read' = 'execute', client?: Pick<PoolClient, 'query'>) {
        const actor = await this.db.get<Actor>('actors', principalId, client);
        const agent = await this.db.get<Agent>('agents', agentId, client);
        if (!actor.active || (!agent.active && action === 'execute') || actor.companyId !== agent.companyId || (actor.id !== agent.ownerId && actor.role !== 'admin' && !actor.permissions.includes(`agent.${action}:${agent.id}`)))
            fail('PERMISSION_DENIED', 'Actor is not authorized for this agent');
        return { actor, agent };
    }
    async invoke(request: Invocation): Promise<Receipt> {
        if(request.runId)await this.coordination?.control.guardRun(request.runId);
        try {
            const { actor, agent } = await this.authorize(request.principalId, request.agentId);
            const plugin = this.pluginFor(agent, request.toolRef);
            const tool = plugin.manifest.provides.tools.find(t => plugin.id + ':' + t.id === request.toolRef);
            if (!tool || !agent.allowedTools.includes(request.toolRef) || (actor.role !== 'admin' && !actor.permissions.includes('tool.invoke:' + request.toolRef)))
                fail('PERMISSION_DENIED', 'Tool is not in effective permissions');
            await this.registry.validateTool(plugin, tool, request.input);
            if (!request.idempotencyKey || request.idempotencyKey.length > 160)
                fail('INVALID_INPUT', 'An idempotency key is required');
            const key = createHash('sha256').update(JSON.stringify([agent.companyId, actor.id, agent.id, plugin.id, plugin.version, tool.id, request.idempotencyKey])).digest('hex');
            const inputHash = contentHash(request.input);
            const inserted = await this.db.pool.query('INSERT INTO invocations(key,input_hash,state) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key', [key, inputHash, 'running']);
            if (!inserted.rowCount) {
                const prior = (await this.db.pool.query('SELECT * FROM invocations WHERE key=$1', [key])).rows[0];
                if (prior.input_hash !== inputHash)
                    fail('CONFLICT', 'Idempotency key reused with changed input');
                if (prior.state === 'succeeded')
                    return prior.receipt;
                fail('RESULT_UNKNOWN', 'Invocation is running or requires reconciliation');
            }
            const invocationId = randomUUID();
            const runId = request.runId ?? randomUUID();
            let dispatched=false;
            try {
                if (tool.effect === 'write') {
                    const approved = await this.db.pool.query('UPDATE approvals SET used_at=now() WHERE id=(SELECT id FROM approvals WHERE principal_id=$1 AND agent_id=$2 AND tool_ref=$3 AND plugin_version=$4 AND input_hash=$5 AND expires_at>now() AND used_at IS NULL ORDER BY expires_at LIMIT 1 FOR UPDATE SKIP LOCKED) AND used_at IS NULL RETURNING id', [actor.id, agent.id, request.toolRef, plugin.version, inputHash]);
                    if (!approved.rowCount)
                        fail('APPROVAL_REQUIRED', 'A one-use administrator approval for the exact write input is required');
                }
                const bindingConfig = this.bindings(agent).find(b => b.pluginId === plugin.id)?.config ?? {};
                const connection = plugin.manifest.entry.kind === 'remote' ? await this.resolveConnection(plugin.manifest.entry.connectionRef, actor.id) : undefined;
                const workerKey = plugin.digest + ':' + agent.id + ':' + contentHash(bindingConfig) + ':' + ((connection as any)?.revision ?? 'legacy');
                let workerPromise = this.workers.get(workerKey);
                if (!workerPromise) {
                    workerPromise = (async () => {
                        const cwd = resolve(this.options.root, 'workspaces', createHash('sha256').update(agent.id).digest('hex'));
                        await mkdir(cwd, { recursive: true });
                        let worker: RpcPeer;
                        let params: unknown;
                        const config = this.bindings(agent).find(b => b.pluginId === plugin.id)?.config ?? {};
                        if (plugin.manifest.entry.kind === 'remote') {
                            if (!connection)
                                fail('UNAVAILABLE', 'Remote connection is not configured');
                            worker = new RemotePeer(connection);
                            params = { protocol: '1.0', pluginId: plugin.id, version: plugin.version, config };
                        }
                        else {
                            worker = new PluginWorker(cwd, (method, params) => this.hostService(workerKey, method, params));
                            params = { protocol: '1.0', entry: await this.registry.packagePath(plugin.directory, plugin.manifest.entry.path), config };
                        }
                        try {
                            const init = await worker.call('plugin.initialize', params);
                            if (init.protocol !== '1.0')
                                fail('UNSUPPORTED_VERSION', 'Peer protocol mismatch');
                            if (JSON.stringify([...init.tools].sort()) !== JSON.stringify(plugin.manifest.provides.tools.map(t => t.id).sort()))
                                fail('INVALID_PACKAGE', 'Worker registration does not match manifest');
                            return worker;
                        }
                        catch (e) {
                            await worker.close();
                            this.workers.delete(workerKey);
                            throw e;
                        }
                    })();
                    this.workers.set(workerKey, workerPromise);
                }
                this.scopes.set(invocationId, { workerKey, request: { ...request, runId } });
                let output: unknown;
                try {
                    const worker=await workerPromise;
                    if(request.runId)await this.coordination?.control.guardRun(request.runId);
                    dispatched=true;
                    output = await worker.call('tool.invoke', { invocationId, runId, toolId: tool.id, input: request.input, idempotencyKey: key, context: { principalId: actor.id, agentId: agent.id, companyId: agent.companyId, runId, pluginId: plugin.id, pluginVersion: plugin.version } });
                }
                catch (error) {
                    if (['RESULT_UNKNOWN', 'PLUGIN_EXITED'].includes((error as any).code)) {
                        this.workers.delete(workerKey);
                        await (await workerPromise.catch(() => null))?.close();
                    }
                    throw error;
                }
                finally {
                    this.scopes.delete(invocationId);
                }
                await this.registry.validateTool(plugin, tool, output, true);
                const evidence = await this.db.audit('tool.succeeded', { principalId: actor.id, agentId: agent.id, runId, invocationId, pluginId: plugin.id, pluginVersion: plugin.version, toolRef: request.toolRef, inputHash });
                const receipt: Receipt = { invocationId, runId, outcome: 'succeeded', output, evidenceRefs: [evidence] };
                await this.db.pool.query('UPDATE invocations SET state=$2,receipt=$3,updated_at=now() WHERE key=$1', [key, 'succeeded', JSON.stringify(receipt)]);
                return receipt;
            }
            catch (error) {
                if ((error as any).code === 'APPROVAL_REQUIRED')
                    await this.db.pool.query('DELETE FROM invocations WHERE key=$1', [key]);
                else
                    await this.db.pool.query('UPDATE invocations SET state=$2,updated_at=now() WHERE key=$1', [key, 'unknown']);
                if (tool.effect === 'write' && dispatched && (error as any).code !== 'APPROVAL_REQUIRED')
                    fail('RESULT_UNKNOWN', 'Write execution did not return a trustworthy receipt; reconcile before retry');
                if(!dispatched&&error instanceof FrameworkError&&request.runId)throw new ActionNotStartedError(error.code,error.message);
                throw error;
            }
        }
        catch (error) {
            await this.db.audit('tool.rejected', { principalId: request.principalId, agentId: request.agentId, toolRef: request.toolRef, code: (error as {
                    code?: string;
                }).code ?? 'ERROR' });
            throw error;
        }
    }
    async close() {
        await this.entries?.close();
        await this.assistant?.close();
        for (const worker of this.workers.values())
            await (await worker.catch(() => null))?.close();
        await this.db.close();
    }
}
export async function createFramework(options: FrameworkOptions) { const framework = new Framework(options); await framework.presets.open(options.presetDirectories); await framework.registry.open(); await framework.db.open(); await framework.channels.open(); return framework; }
