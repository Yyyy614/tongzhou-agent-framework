import type { FastifyInstance } from 'fastify';
import type { Framework } from './index.js';
import type { Actor, Agent } from './types.js';
import { readFile } from 'node:fs/promises';
import { fail } from './errors.js';
export function registerAdminObservability(api: FastifyInstance, host: Framework) {
    const company = async (request: any) => (await host.db.get<Actor>('actors', request.principalId)).companyId;
    const visible = "(EXISTS(SELECT 1 FROM agents a WHERE a.id=e.data->>'agentId' AND a.data->>'companyId'=$1) OR EXISTS(SELECT 1 FROM actors p WHERE p.id=e.data->>'principalId' AND p.data->>'companyId'=$1) OR e.data->>'companyId'=$1)";
    api.get('/plugins', async () => {
        return Promise.all(host.registry.list().map(async (plugin) => {
            const load = async (ref: string) => JSON.parse(await readFile(await host.registry.packagePath(plugin.directory, ref), 'utf8'));
            const tools = await Promise.all(plugin.manifest.provides.tools.map(async (tool) => ({ ...tool, ref: plugin.id + ':' + tool.id, inputSchema: await load(tool.inputSchema), outputSchema: await load(tool.outputSchema) })));
            return { id: plugin.id, version: plugin.version, digest: plugin.digest, enabled: plugin.enabled, permissions: plugin.manifest.permissions, presets: plugin.manifest.provides.presets, configSchema: await load(plugin.manifest.configSchema), tools };
        }));
    });
    api.post('/plugins/state', { schema: { body: { type: 'object', additionalProperties: false, required: ['pluginId', 'version', 'enabled'], properties: { pluginId: { type: 'string' }, version: { type: 'string' }, enabled: { type: 'boolean' } } } } }, async (request) => { await host.setPluginEnabled({ ...request.body as any, principalId: (request as any).principalId }); return { ok: true }; });
    api.post('/plugins/validate', { schema: { body: { type: 'object', additionalProperties: false, required: ['pluginId', 'version'], properties: { pluginId: { type: 'string' }, version: { type: 'string' }, config: { type: 'object' } } } } }, async (request) => { const b = request.body as any; return host.validatePlugin(b.pluginId, b.version, b.config ?? {}); });
    api.get<{
        Querystring: {
            agentId?: string;
            type?: string;
            q?: string;
            before?: string;
        };
    }>('/activity', async (request) => {
        const { agentId, type, q, before } = request.query;
        if ((q?.length ?? 0) > 200 || (type?.length ?? 0) > 100 || before && !/^\d{1,19}$/u.test(before))
            fail('INVALID_INPUT', 'Invalid log filter');
        const result = await host.db.pool.query(`SELECT e.seq::text AS cursor,e.id,e.type,e.data,e.created_at AS "createdAt" FROM audit e WHERE ${visible} AND ($2::text IS NULL OR e.data->>'agentId'=$2) AND ($3::text IS NULL OR e.type=$3) AND ($4::text IS NULL OR e.type ILIKE '%'||$4||'%' OR e.data::text ILIKE '%'||$4||'%') AND ($5::bigint IS NULL OR e.seq<$5) ORDER BY e.seq DESC LIMIT 101`, [await company(request), agentId ?? null, type ?? null, q ?? null, before ?? null]);
        const items = result.rows.slice(0, 100);
        return { items, nextCursor: result.rows.length > 100 ? items.at(-1)?.cursor : null };
    });
    api.get<{
        Querystring: {
            days?: string;
            agentId?: string;
            principalId?: string;
        };
    }>('/usage', async (request) => {
        const days = Number(request.query.days ?? 7);
        if (![7, 30, 90].includes(days))
            fail('INVALID_INPUT', 'Usage window must be 7, 30 or 90 days');
        const companyId = await company(request);
        const values = [companyId, days, request.query.agentId ?? null, request.query.principalId ?? null];
        const scope = `FROM usage u LEFT JOIN agents a ON a.id=u.data->>'agentId' WHERE coalesce(u.data->>'companyId',a.data->>'companyId')=$1 AND (u.created_at AT TIME ZONE 'Asia/Shanghai')::date >= (now() AT TIME ZONE 'Asia/Shanghai')::date-($2::int-1) AND ($3::text IS NULL OR u.data->>'agentId'=$3) AND ($4::text IS NULL OR u.data->>'principalId'=$4)`;
        const numeric = (rows: any[]) => rows.map(r => ({ ...r, requests: Number(r.requests), inputTokens: Number(r.inputTokens ?? 0), outputTokens: Number(r.outputTokens ?? 0), cacheReadTokens: Number(r.cacheReadTokens ?? 0), unmeasuredRequests: r.unmeasuredRequests === undefined ? undefined : Number(r.unmeasuredRequests), reportedRequests: r.reportedRequests === undefined ? undefined : Number(r.reportedRequests) }));
        const sums = `count(*)::int AS requests,coalesce(sum((u.data->>'inputTokens')::bigint),0)::text AS "inputTokens",coalesce(sum((u.data->>'outputTokens')::bigint),0)::text AS "outputTokens",coalesce(sum((u.data->>'cacheReadTokens')::bigint),0)::text AS "cacheReadTokens"`;
        const [totals, series, byEmployee, byAgent, records] = await Promise.all([
            host.db.pool.query(`SELECT ${sums},count(*) FILTER(WHERE u.data->>'measurement'='unavailable')::int AS "unmeasuredRequests",count(*) FILTER(WHERE u.data->>'measurement'='remote-reported')::int AS "reportedRequests" ${scope}`, values),
            host.db.pool.query(`SELECT (u.created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day,${sums} ${scope} GROUP BY day ORDER BY day`, values),
            host.db.pool.query(`SELECT u.data->>'principalId' AS "principalId",${sums} ${scope} GROUP BY u.data->>'principalId' ORDER BY sum(coalesce((u.data->>'inputTokens')::bigint,0)+coalesce((u.data->>'outputTokens')::bigint,0)) DESC`, values),
            host.db.pool.query(`SELECT u.data->>'agentId' AS "agentId",${sums} ${scope} GROUP BY u.data->>'agentId' ORDER BY count(*) DESC`, values),
            host.db.pool.query(`SELECT u.id,u.run_id AS "runId",u.created_at AS "createdAt",u.data ${scope} ORDER BY u.created_at DESC LIMIT 100`, values)
        ]);
        const indexed = new Map(numeric(series.rows).map(r => [r.day, r]));
        const format = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
        const filled = Array.from({ length: days }, (_, i) => { const day = format.format(new Date(Date.now() - (days - 1 - i) * 86400000)); return indexed.get(day) ?? { day, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; });
        return { days, timeZone: 'Asia/Shanghai', totals: numeric(totals.rows)[0], series: filled, byEmployee: numeric(byEmployee.rows), byAgent: numeric(byAgent.rows), records: records.rows, priceStatus: 'unconfigured', recordsLimit: 100 };
    });
    api.get('/overview', async (request) => {
        const companyId = await company(request);
        const [people, agents, tasks, recent] = await Promise.all([host.db.list<Actor>('actors'), host.db.list<Agent>('agents'), host.db.pool.query("SELECT t.state,count(*)::int AS count FROM tasks t JOIN agents a ON a.id=t.agent_id WHERE a.data->>'companyId'=$1 GROUP BY t.state", [companyId]), host.db.pool.query("SELECT r.id,r.agent_id AS \"agentId\",r.principal_id AS \"principalId\",r.state,CASE WHEN r.data ? 'resultFormat' THEN '执行记录待整理或核实' ELSE left(r.data->>'output',500) END AS summary,r.data->>'taskId' AS \"taskId\",r.data->'error' AS error,r.created_at AS \"createdAt\" FROM runs r JOIN agents a ON a.id=r.agent_id WHERE a.data->>'companyId'=$1 ORDER BY r.created_at DESC LIMIT 8", [companyId])]);
        for(const run of recent.rows)if(run.taskId){const result=await host.results.view((request as any).principalId,run.taskId);if(result)run.summary=result.summary;}
        const employees = people.filter(p => p.companyId === companyId);
        const ownAgents = agents.filter(a => a.companyId === companyId);
        return { counts: { employees: employees.length, activeEmployees: employees.filter(p => p.active).length, agents: ownAgents.length, activeAgents: ownAgents.filter(a => a.active).length, plugins: host.registry.list().length }, tasks: tasks.rows, recentRuns: recent.rows, version: '0.1.0', runtime: 'DeepSeek Harness', channels: [{ id: 'dingtalk', name: '钉钉', status: 'not_connected' }, { id: 'feishu', name: '飞书', status: 'not_connected' }, { id: 'wecom', name: '企业微信', status: 'not_connected' }] };
    });
}
