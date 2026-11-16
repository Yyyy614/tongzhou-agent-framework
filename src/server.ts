import Fastify from 'fastify';
import type { Framework } from './index.js';
import type { MemoryWrite } from './types.js';
import { FrameworkError, fail } from './errors.js';
import { registerConsoleAuth, authenticateRequest } from './console-auth.js';
import { registerAdmin } from './admin.js';
import { registerWeb } from './web.js';
import { registerEmployeeAccess } from './employee-access.js';
import { isIP } from 'node:net';
export async function createServer(host: Framework, options: { trustedProxyIP?: string;publicBasePath?:string;webProfile?:'classic'|'studio' } = {}) {
    if(options.publicBasePath&&!/^(?:\/[A-Za-z0-9_-]+)+$/u.test(options.publicBasePath))fail('INVALID_INPUT','Invalid public deployment path');
    if (options.trustedProxyIP && !isIP(options.trustedProxyIP)) fail('INVALID_INPUT', 'Trusted proxy must be an exact IP address');
    const app = Fastify({ logger: false, trustProxy: options.trustedProxyIP ?? false, bodyLimit: 200000, ajv: { customOptions: { removeAdditional: false } } });
    registerConsoleAuth(app, host);
    registerAdmin(app, host);
    host.organization.registerRoutes(app);
    host.channels.registerRoutes(app);
    host.resources.registerRoutes(app);
    host.workMemory.registerRoutes(app);
    host.market.registerRoutes(app);
    host.events.registerRoutes(app);
    registerEmployeeAccess(app, host);
    if(options.webProfile!==undefined&&!['classic','studio'].includes(options.webProfile))fail('INVALID_INPUT','Unknown company UI profile');
    registerWeb(app,{publicBasePath:options.publicBasePath??'',entries:host.options.entries===true,profile:options.webProfile??'classic'});
    app.setErrorHandler((error, request, reply) => {
        const code = error instanceof FrameworkError ? error.code : (error as any).validation ? 'INVALID_INPUT' : 'INTERNAL_ERROR';
        const status = ({ UNAUTHENTICATED: 401, PERMISSION_DENIED: 403, NOT_FOUND: 404, CONFLICT: 409, RESULT_UNKNOWN: 409, APPROVAL_REQUIRED: 409, INVALID_INPUT: 400, INVALID_OUTPUT: 502, PLUGIN_UNAVAILABLE: 409, UNAVAILABLE: 503, PROVIDER_UNAVAILABLE: 503, BUDGET_EXCEEDED: 429, CONTEXT_BUDGET_EXCEEDED: 413, CANCELLED: 409 } as Record<string, number>)[code] ?? 500;
        reply.code(status).send({ error: { code, message: error instanceof FrameworkError ? error.message : code === 'INVALID_INPUT' ? 'Request schema is invalid' : 'Request failed; inspect host audit' } });
    });
    app.get('/health', async () => ({ status: 'ok', version: '0.1.0' }));
    app.register(async (api) => {
        api.addHook('preHandler', async (request) => { (request as any).principalId = (await authenticateRequest(host, request)).id; });
        api.post('/invoke', { schema: { body: { type: 'object', additionalProperties: false, required: ['agentId', 'toolRef', 'input', 'idempotencyKey'], properties: { agentId: { type: 'string' }, toolRef: { type: 'string' }, input: {}, idempotencyKey: { type: 'string', minLength: 1, maxLength: 160 } } } } }, async (request) => host.invoke({ ...request.body as any, principalId: (request as any).principalId }));
        api.get<{
            Params: {
                agentId: string;
            };
        }>('/agents/:agentId/memory', async (request) => host.memory.list({ ...request.params, principalId: (request as any).principalId }));
        api.get<{
            Params: {
                agentId: string;
                noteId: string;
            };
        }>('/agents/:agentId/memory/:noteId', async (request) => host.readMemory({ ...request.params, principalId: (request as any).principalId }));
        api.put<{
            Params: {
                agentId: string;
                noteId: string;
            };
        }>('/agents/:agentId/memory/:noteId', { schema: { body: { type: 'object', additionalProperties: false, required: ['markdown', 'expectedVersion', 'sourceRefs'], properties: { markdown: { type: 'string', maxLength: 32000 }, expectedVersion: { type: 'integer', minimum: 0 }, sourceRefs: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 240 } } } } } }, async (request) => host.writeMemory({ ...request.body as object, ...request.params, principalId: (request as any).principalId } as MemoryWrite));
        api.get<{
            Params: {
                agentId: string;
            };
        }>('/agents/:agentId/logs', async (request) => host.listLogs({ ...request.params, principalId: (request as any).principalId }));
        api.get('/plugins', async request => host.market.plugins((request as any).principalId));
        api.get('/presets', async () => host.presets.list());
        api.get('/agents', async (request) => { const actor = await host.db.get<import('./types.js').Actor>('actors', (request as any).principalId); return (await host.db.list<import('./types.js').Agent>('agents')).filter(a => a.companyId === actor.companyId && (actor.role === 'admin' || a.ownerId === actor.id || actor.permissions.includes('agent.read:' + a.id))).map(({ config, plugins, ...agent }) => ({ ...agent, plugins: plugins?.map(({ config, ...binding }) => binding) })); });
        api.get<{
            Params: {
                agentId: string;
            };
        }>('/agents/:agentId/reports', async (request) => host.reportSummary({ ...request.params, principalId: (request as any).principalId }));
        api.patch<{
            Params: {
                agentId: string;
            };
        }>('/agents/:agentId/preferences', { schema: { body: { type: 'object', additionalProperties: false, required: ['replyStyle'], properties: { replyStyle: { type: 'string', maxLength: 1500 } } } } }, async (request) => host.personalize({ ...request.params, ...request.body as any, principalId: (request as any).principalId }));
        api.post<{
            Params: {
                agentId: string;
            };
        }>('/agents/:agentId/feedback', { schema: { body: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string', minLength: 1, maxLength: 4000 }, runId: { type: 'string', format: 'uuid' } } } } }, async (request) => host.feedback({ ...request.params, ...request.body as any, principalId: (request as any).principalId }));
        api.post('/releases', { schema: { body: { type: 'object', additionalProperties: false, required: ['agentId', 'pluginVersion', 'reason'], properties: { agentId: { type: 'string' }, pluginId: { type: 'string' }, pluginVersion: { type: 'string' }, reason: { type: 'string', minLength: 1, maxLength: 1000 } } } } }, async (request) => host.releaseAgent({ ...request.body as any, principalId: (request as any).principalId }));
        api.post('/approvals', { schema: { body: { type: 'object', additionalProperties: false, required: ['targetPrincipalId', 'agentId', 'toolRef', 'input', 'reason'], properties: { targetPrincipalId: { type: 'string' }, agentId: { type: 'string' }, toolRef: { type: 'string' }, input: {}, reason: { type: 'string', minLength: 1, maxLength: 1000 } } } } }, async (request) => host.approveTool({ ...request.body as any, principalId: (request as any).principalId }));
        api.post('/plugins/install', { schema: { body: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', maxLength: 500 } } } } }, async (request) => {
            const actor = await host.db.get<import('./types.js').Actor>('actors', (request as any).principalId);
            if (actor.role !== 'admin')
                fail('PERMISSION_DENIED', 'Only administrators install reviewed packages');
            const plugin = await host.installPlugin((request.body as any).path,actor.id);
            const { directory, ...result } = plugin;
            return result;
        });
    }, { prefix: '/v1' });
    return app;
}
