import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { valid } from 'semver';
import type { FastifyInstance } from 'fastify';
import type { Framework } from './index.js';
import type { Actor, Agent } from './types.js';
import { contentHash, requireUuid } from './contracts.js';
import { authenticateRequest } from './console-auth.js';
import { fail } from './errors.js';
import { decodePackage, inspectPackage, stagePackage, marketInputSchema, type MarketInput } from './market-package.js';
import type{SourceOrigin}from'./provenance.js';

export interface MarketGrants { principalIds: string[]; presetIds: string[]; departmentIds: string[]; toolRefs: string[]; services: string[]; allCompany?: boolean; }
const noGrants = (): MarketGrants => ({ principalIds: [], presetIds: [], departmentIds: [], toolRefs: [], services: [] });
const list = { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 240 } };
const grantSchema = { type: 'object', additionalProperties: false, required: ['principalIds', 'presetIds', 'departmentIds', 'toolRefs', 'services'], properties: { principalIds: list, presetIds: list, departmentIds: list, toolRefs: list, services: list, allCompany: { type: 'boolean' } } };
const changeSchema = { type: 'object', additionalProperties: false, required: ['revision', 'reason'], properties: { revision: { type: 'string', pattern: '^[a-f0-9]{64}$' }, reason: { type: 'string', minLength: 1, maxLength: 1000 } } };
const publishSchema = { ...changeSchema, properties: { ...changeSchema.properties, grants: grantSchema } };

/** A private company registry. Upload, publication, mounting and grants are separate. */
export class CapabilityMarket {
    constructor(readonly host: Framework) {}
    async open() {
        await mkdir(resolve(this.host.options.root, 'market-candidates'), { recursive: true, mode: 0o700 });
        await this.host.db.pool.query(`
          CREATE TABLE IF NOT EXISTS market_assets(id uuid PRIMARY KEY,company_id text NOT NULL,owner_id text NOT NULL,asset_key text NOT NULL,version text NOT NULL,kind text NOT NULL,state text NOT NULL,revision integer NOT NULL DEFAULT 1,digest text NOT NULL,input_hash text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,asset_key,version));
          CREATE TABLE IF NOT EXISTS market_history(id uuid PRIMARY KEY,asset_id uuid NOT NULL REFERENCES market_assets(id),principal_id text NOT NULL,action text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
          CREATE TABLE IF NOT EXISTS market_installations(asset_id uuid NOT NULL REFERENCES market_assets(id),agent_id text NOT NULL,company_id text NOT NULL,owner_id text NOT NULL,active boolean NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(asset_id,agent_id));
        `);
    }
    private async actor(id: string, client = this.host.db.pool) { const actor = await this.host.db.get<Actor>('actors', id, client); if (!actor.active) fail('PERMISSION_DENIED', 'Inactive market member'); return actor; }
    private revision(row: any) { return contentHash([row.id, row.revision]); }
    private reviewer(actor: Actor, row: any) { return actor.companyId === row.company_id && (actor.role === 'admin' || row.data.scope === 'department' && actor.departmentId === row.data.departmentId && actor.permissions.includes('market.review')); }
    private visible(actor: Actor, row: any) { return actor.companyId === row.company_id && (actor.id === row.owner_id || row.data.scope === 'company' || row.data.scope === 'department' && !!actor.departmentId && actor.departmentId === row.data.departmentId); }
    private dto(row: any, manage = false) {
        return { id: row.id, assetKey: row.asset_key, version: row.version, kind: row.kind,contentType:row.data.contentType??row.kind, state: row.state, revision: this.revision(row), digest: row.digest, name: row.data.name, summary: row.data.summary, scope: row.data.scope, departmentId: row.data.departmentId ?? null, submittedBy: row.owner_id, createdAt: row.created_at, ...(manage ? { checks: row.data.checks, review: row.data.review ?? null, files: row.data.files, inspection:row.data.inspection,grants: row.data.grants ?? noGrants() } : {}) };
    }
    private async row(actor: Actor, id: string, manage = false) {
        requireUuid(id); const row = (await this.host.db.pool.query('SELECT * FROM market_assets WHERE id=$1 AND company_id=$2', [id, actor.companyId])).rows[0];
        if (!row || (manage ? actor.id !== row.owner_id && !this.reviewer(actor, row) : !this.visible(actor, row))||!await this.sourceVisible(actor.id,row)) fail('NOT_FOUND', 'Capability is unavailable'); return row;
    }
    private async sourceVisible(principalId:string,row:any,client:any=this.host.db.pool){if(!row.data.dependencies)return true;const status=await this.host.provenance.status(principalId,row.data.dependencies,client);return status.visible&&status.current;}
    async submit(principalId: string, input: MarketInput,derivation?:{sources:SourceOrigin[]}) {
        if (!this.host.registry.ajv.validate(marketInputSchema, input) || !valid(input.version)) fail('INVALID_INPUT', 'Invalid capability package');
        const actor = await this.actor(principalId), decoded = decodePackage(input.files);
        if (input.scope === 'department') {
            const department = (await this.host.db.pool.query('SELECT data FROM departments WHERE id=$1', [input.departmentId])).rows[0]?.data;
            if (!department?.active || department.companyId !== actor.companyId || actor.role !== 'admin' && department.id !== actor.departmentId) fail('PERMISSION_DENIED', 'Choose your current company department');
        }
        const canonical={ ...input, idempotencyKey: undefined, files: decoded.files.map(([path, bytes]) => ({ path, contentBase64: bytes.toString('base64') })) },hash=contentHash(derivation?[canonical,derivation.sources]:canonical);
        const existing = (await this.host.db.pool.query('SELECT * FROM market_assets WHERE company_id=$1 AND asset_key=$2 ORDER BY created_at', [actor.companyId, input.assetKey])).rows;
        const prior = existing.find(row => row.version === input.version);
        if (prior) { if (prior.owner_id !== actor.id || prior.input_hash !== hash) fail('CONFLICT', 'An immutable capability version already exists'); return this.dto(prior, true); }
        if (existing.length && existing[0].owner_id !== actor.id && actor.role !== 'admin') fail('PERMISSION_DENIED', 'Only the capability maintainer submits a new version');
        if ((await this.host.db.pool.query("SELECT count(*)::int AS n FROM market_assets WHERE owner_id=$1 AND created_at>now()-interval '1 day'", [actor.id])).rows[0].n >= 100) fail('BUDGET_EXCEEDED', 'Submission limit reached');
        const id = randomUUID(), directory = resolve(this.host.options.root, 'market-candidates', id); await stagePackage(directory, decoded.files);
        let inspection: any = {}, checks: any;
        try { inspection = await inspectPackage(this.host.registry, input, directory); checks = { passed: true, mode: 'static-no-execution', bytes: decoded.bytes, fileCount: decoded.files.length }; }
        catch (error) { checks = { passed: false, mode: 'static-no-execution', code: (error as any).code ?? 'INVALID_PACKAGE', bytes: decoded.bytes, fileCount: decoded.files.length }; }
        const client = await this.host.db.pool.connect();
        try {
            await client.query('BEGIN'); await this.host.organization.lock(client);
            const currentActor=await this.actor(principalId, client as any);
            if(currentActor.companyId!==actor.companyId)fail('PERMISSION_DENIED','Contributor company changed during upload');
            const maintainer=(await client.query('SELECT owner_id FROM market_assets WHERE company_id=$1 AND asset_key=$2 ORDER BY created_at,id LIMIT 1',[actor.companyId,input.assetKey])).rows[0];
            if(maintainer&&maintainer.owner_id!==currentActor.id&&currentActor.role!=='admin')fail('PERMISSION_DENIED','Only the capability maintainer submits a new version');
            if(input.scope==='department'&&currentActor.role!=='admin'&&currentActor.departmentId!==input.departmentId)fail('PERMISSION_DENIED','Contributor department changed during upload');
            const concurrent = (await client.query('SELECT id FROM market_assets WHERE company_id=$1 AND asset_key=$2 AND version=$3', [actor.companyId, input.assetKey, input.version])).rows[0];
            if (concurrent) fail('CONFLICT', 'Capability submission changed concurrently');
            if(derivation&&!(await this.host.provenance.status(currentActor.id,derivation.sources,client)).visible)fail('PERMISSION_DENIED','Candidate sources are unavailable');
            const data = { name: input.name, summary: input.summary,contentType:input.contentType??input.kind,dependencies:derivation?.sources, scope: input.scope, departmentId: input.departmentId, directory, files: decoded.files.map(([path, body]) => ({ path, bytes: body.length,digest:contentHash(body.toString('base64')) })), checks, inspection, grants: noGrants() };
            await client.query('INSERT INTO market_assets(id,company_id,owner_id,asset_key,version,kind,state,digest,input_hash,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, actor.companyId, actor.id, input.assetKey, input.version, input.kind, 'submitted', decoded.digest, hash, JSON.stringify(data)]);
            await client.query('INSERT INTO market_history(id,asset_id,principal_id,action,data) VALUES($1,$2,$3,$4,$5)', [randomUUID(), id, actor.id, 'submitted', JSON.stringify({ digest: decoded.digest, checks })]);
            await client.query('COMMIT'); return this.get(actor.id, id);
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    async get(principalId: string, id: string) { const actor = await this.actor(principalId); return this.dto(await this.row(actor, id, true), true); }
    async file(principalId:string,id:string,path:string,offset=0){
        const actor=await this.actor(principalId),row=await this.row(actor,id,true);
        return this.packageFile(row,path,offset);
    }
    private async packageFile(row:any,path:string,offset:number){
        if(typeof path!=='string'||!row.data.files.some((f:any)=>f.path===path)||!Number.isInteger(offset)||offset<0)fail('NOT_FOUND','Reviewed package file is unavailable');
        const body=await readFile(await this.host.registry.packagePath(row.data.directory,'./'+path));
        if(row.data.files.find((f:any)=>f.path===path).digest!==contentHash(body.toString('base64')))fail('CONFLICT','Candidate file differs from submitted version');
        if(body.includes(0))return{path,binary:true,bytes:body.length,text:'二进制资源，请通过受控审查工具核查。',nextOffset:null};
        const value=body.toString('utf8');return{path,text:value.slice(offset,offset+16000),offset,nextOffset:offset+16000<value.length?offset+16000:null,digest:contentHash(body.toString('base64'))};
    }
    async history(principalId:string,id:string){const actor=await this.actor(principalId);await this.row(actor,id,true);return{items:(await this.host.db.pool.query('SELECT principal_id AS "principalId",action,data,created_at AS "createdAt" FROM market_history WHERE asset_id=$1 ORDER BY created_at',[id])).rows};}
    async release(principalId:string,id:string){
        const actor=await this.actor(principalId),row=await this.row(actor,id);
        if(row.state!=='published')fail('NOT_FOUND','Published capability is unavailable');
        if(row.kind!=='plugin')return this.dto(row);
        const configSchema=JSON.parse(await readFile(await this.host.registry.packagePath(row.data.directory,row.data.inspection.manifest.configSchema),'utf8'));
        return{...this.dto(row),configSchema,requestedPermissions:row.data.inspection.manifest.permissions};
    }
    async submissions(principalId: string) {
        const actor = await this.actor(principalId), rows = (await this.host.db.pool.query('SELECT * FROM market_assets WHERE company_id=$1 ORDER BY created_at DESC LIMIT 200', [actor.companyId])).rows;
        const items=[];for(const row of rows)if((row.owner_id===actor.id||this.reviewer(actor,row))&&await this.sourceVisible(actor.id,row))items.push(this.dto(row,true));return{items};
    }
    async releases(principalId: string, query = '') {
        if (typeof query !== 'string' || query.length > 200) fail('INVALID_INPUT', 'Invalid market search');
        const actor = await this.actor(principalId), rows = (await this.host.db.pool.query("SELECT * FROM market_assets WHERE company_id=$1 AND state='published' ORDER BY created_at DESC LIMIT 500", [actor.companyId])).rows;
        const items=[];for(const row of rows)if(this.visible(actor,row)&&(row.data.name+' '+row.data.summary+' '+row.asset_key).toLowerCase().includes(query.toLowerCase())&&await this.sourceVisible(actor.id,row))items.push(this.dto(row));return{items,coverage:'company-only'};
    }
    private async change(principalId: string, id: string, input: { revision: string; reason: string }, action: string, mutate: (row: any, actor: Actor, client: any) => Promise<void>) {
        const actor = await this.actor(principalId); await this.row(actor, id, true);
        if (!input.reason?.trim() || input.reason.length > 1000) fail('INVALID_INPUT', 'An explicit decision reason is required');
        const client = await this.host.db.pool.connect();
        try {
            await client.query('BEGIN'); await this.host.organization.lock(client);
            const currentActor = await this.actor(principalId, client as any), row = (await client.query('SELECT * FROM market_assets WHERE id=$1 FOR UPDATE', [id])).rows[0];
            if (!this.reviewer(currentActor, row)) fail('PERMISSION_DENIED', 'Capability governance is outside your scope');
            if(!await this.sourceVisible(currentActor.id,row,client))fail('PERMISSION_DENIED','Candidate sources changed');
            if (this.revision(row) !== input.revision) fail('CONFLICT', 'Capability changed; reload its revision');
            await mutate(row, currentActor, client);
            await client.query('UPDATE market_assets SET state=$2,data=$3,revision=revision+1 WHERE id=$1', [id, row.state, JSON.stringify(row.data)]);
            await client.query('INSERT INTO market_history(id,asset_id,principal_id,action,data) VALUES($1,$2,$3,$4,$5)', [randomUUID(), id, currentActor.id, action, JSON.stringify({ reason: input.reason, priorRevision: input.revision })]);
            await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'market.' + action, JSON.stringify({ principalId: currentActor.id, companyId: currentActor.companyId, assetId: id, reason: input.reason })]);
            await client.query('COMMIT'); return this.get(currentActor.id, id);
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    async review(principalId: string, id: string, input: { revision: string; reason: string; decision: 'approve' | 'reject' }) {
        if (!['approve', 'reject'].includes(input.decision)) fail('INVALID_INPUT', 'Choose an explicit review decision');
        return this.change(principalId, id, input, 'reviewed', async (row, actor) => {
            if (row.owner_id === actor.id) fail('PERMISSION_DENIED', 'A package needs a reviewer other than its contributor');
            if (row.state !== 'submitted' || input.decision === 'approve' && !row.data.checks.passed) fail('CONFLICT', 'Only checked submissions can be approved');
            row.state = input.decision === 'approve' ? 'approved' : 'rejected'; row.data.review = { by: actor.id, reason: input.reason, digest: row.digest, decision: input.decision };
        });
    }
    async publish(principalId: string, id: string, input: { revision: string; reason: string; grants?: MarketGrants }) {
        const actor = await this.actor(principalId), candidate = await this.row(actor, id, true);
        if (!this.reviewer(actor, candidate)) fail('PERMISSION_DENIED', 'Only an authorized publisher can release capabilities');
        if (candidate.state !== 'approved' || !candidate.data.checks.passed || this.revision(candidate) !== input.revision) fail('CONFLICT', 'An approved immutable candidate is required');
        const grants = input.grants ?? noGrants();
        if (!this.host.registry.ajv.validate(grantSchema, grants)) fail('INVALID_INPUT', 'Invalid installation policy');
        const inspection = await inspectPackage(this.host.registry, { ...candidate.data, assetKey: candidate.asset_key, kind: candidate.kind, version: candidate.version, files: candidate.data.files } as any, candidate.data.directory);
        if(candidate.kind==='plugin'&&actor.role!=='admin')fail('PERMISSION_DENIED','Company administrators must approve execution of reviewed plugin code');
        const declared=new Set((inspection as any).manifest?.provides.tools.map((tool:any)=>candidate.asset_key+':'+tool.id)??[]);
        if(grants.toolRefs.some(tool=>!declared.has(tool))||grants.services.some(service=>!(inspection as any).manifest?.permissions.includes(service)))fail('INVALID_INPUT','Grants exceed the reviewed plugin declaration');
        if((grants.toolRefs.length||grants.services.length)&&!grants.allCompany&&!grants.principalIds.length&&!grants.presetIds.length&&!grants.departmentIds.length)fail('INVALID_INPUT','Select an explicit grant audience');
        const decoded = decodePackage(await Promise.all(candidate.data.files.map(async (f: any) => ({ path: f.path, contentBase64: (await readFile(resolve(candidate.data.directory, f.path))).toString('base64') }))));
        if (decoded.digest !== candidate.digest || candidate.data.review.digest !== candidate.digest) fail('CONFLICT', 'Reviewed package contents changed');
        let resource: any;
        if (candidate.kind === 'skill') resource = await this.host.resources.create(actor.id, { title: candidate.data.name, kind: 'skill', domain: 'company-skills', body: await readFile(resolve(candidate.data.directory, 'SKILL.md'), 'utf8'), access: { scope: 'personal', readerIds: [] }, idempotencyKey: 'market-publication:' + id, sourceRefs: ['market:' + id, 'contributor:' + candidate.owner_id] },candidate.data.dependencies?{sources:candidate.data.dependencies}:undefined);
        else await this.host.installPlugin(candidate.data.directory, actor.id);
        return this.change(principalId, id, input, 'published', async (row, publisher, client) => {
            if (row.state !== 'approved' || row.digest !== decoded.digest) fail('CONFLICT', 'Publication candidate changed');
            for (const member of grants.principalIds) { const data = (await client.query('SELECT data FROM actors WHERE id=$1', [member])).rows[0]?.data; if (!data?.active || data.companyId !== publisher.companyId) fail('PERMISSION_DENIED', 'Grant recipients must be company members'); }
            const declared = new Set((inspection as any).manifest?.provides.tools.map((tool: any) => row.asset_key + ':' + tool.id) ?? []);
            if (grants.toolRefs.some(tool => !declared.has(tool)) || grants.services.some(service => !(inspection as any).manifest?.permissions.includes(service))) fail('INVALID_INPUT', 'Grants exceed the reviewed plugin declaration');
            if ((grants.toolRefs.length || grants.services.length) && !grants.allCompany && !grants.principalIds.length && !grants.presetIds.length && !grants.departmentIds.length) fail('INVALID_INPUT', 'Select an explicit grant audience');
            if (resource) {
                if(row.data.dependencies){const people=(await client.query("SELECT data FROM actors WHERE data->>'companyId'=$1 AND (data->>'active')::boolean=true",[publisher.companyId])).rows;for(const person of people)if(this.visible(person.data,row)&&!await this.sourceVisible(person.data.id,row,client))fail('PERMISSION_DENIED','Publication audience cannot read every source; re-author from shareable evidence');}
                const access = { scope: row.data.scope, readerIds: row.data.scope === 'personal' ? [row.owner_id] : [], ...(row.data.scope === 'department' ? { departmentId: row.data.departmentId } : {}) };
                await client.query('UPDATE company_resources SET access=$2,access_epoch=access_epoch+1,updated_at=now() WHERE id=$1', [resource.id, JSON.stringify(access)]); row.data.resourceRef = { id: resource.id, version: resource.version };
                await this.host.resourceIndex.schedule(client,resource.id,'market-published');
            }
            row.data.grants = grants; row.state = 'published'; row.data.publishedBy = publisher.id;
        });
    }
    async state(principalId: string, id: string, input: { revision: string; reason: string; state: 'published' | 'suspended' }) {
        if (!['published', 'suspended'].includes(input.state)) fail('INVALID_INPUT', 'Invalid release state');
        return this.change(principalId, id, input, input.state, async (row, _actor, client) => {
            if (!['published', 'suspended'].includes(row.state)) fail('CONFLICT', 'Only published releases can change availability');
            row.state = input.state;
            if (row.data.resourceRef){await client.query('UPDATE company_resources SET active=$2,access_epoch=access_epoch+1,updated_at=now() WHERE id=$1', [row.data.resourceRef.id, input.state === 'published']);await this.host.resourceIndex.schedule(client,row.data.resourceRef.id,'market-state-changed');}
        });
    }
    private audience(actor: Actor, agent: Agent, grants: MarketGrants) { return grants.allCompany || grants.principalIds.includes(actor.id) || !!agent.preset && grants.presetIds.includes(agent.preset.id) || !!actor.departmentId && grants.departmentIds.includes(actor.departmentId); }
    async install(principalId: string, id: string, agentId: string, config: Record<string, unknown> = {}) {
        const { actor, agent } = await this.host.authorize(principalId, agentId), owner = await this.actor(agent.ownerId), row = await this.row(owner, id);
        if (actor.id !== agent.ownerId && actor.role !== 'admin') fail('PERMISSION_DENIED', 'Install capabilities only on your own job');
        if (row.state !== 'published') fail('CONFLICT', 'Only published capabilities can be installed');
        const client = await this.host.db.pool.connect();
        try {
            await client.query('BEGIN'); await this.host.organization.lock(client);
            const current = (await client.query('SELECT data FROM agents WHERE id=$1 FOR UPDATE', [agentId])).rows[0].data as Agent;
            const freshActor=await this.actor(actor.id,client as any),freshOwner=await this.actor(owner.id,client as any);
            if(freshActor.companyId!==current.companyId||!freshActor.active||freshActor.id!==current.ownerId&&freshActor.role!=='admin'||freshOwner.id!==current.ownerId||freshOwner.companyId!==current.companyId)fail('PERMISSION_DENIED','Job ownership changed');
            if (contentHash(current) !== contentHash(agent) || this.host.hasActiveInvocation(agentId) || (await client.query("SELECT 1 FROM runs WHERE agent_id=$1 AND state='running'", [agentId])).rowCount) fail('CONFLICT', 'Finish the active turn before changing capabilities');
            const release = (await client.query('SELECT * FROM market_assets WHERE id=$1 FOR SHARE', [id])).rows[0];
            if (release.state !== 'published' || !this.visible(await this.actor(owner.id, client as any), release)) fail('CONFLICT', 'Release is no longer available');
            if(!await this.sourceVisible(freshOwner.id,release,client))fail('PERMISSION_DENIED','Release sources changed');
            const releaseGrants=release.data.grants as MarketGrants;
            if((releaseGrants.principalIds.length||releaseGrants.presetIds.length||releaseGrants.departmentIds.length||releaseGrants.allCompany)&&!this.audience(freshOwner,current,releaseGrants))fail('PERMISSION_DENIED','This release is currently limited to the approved pilot audience');
            const prior = (await client.query('SELECT * FROM market_installations WHERE asset_id=$1 AND agent_id=$2', [id, agentId])).rows[0];
            if (prior?.active) { await client.query('COMMIT'); return { installed: true, release: this.dto(row), agentId }; }
            if ((await client.query('SELECT count(*)::int AS n FROM market_installations WHERE agent_id=$1 AND active=true', [agentId])).rows[0].n >= 16) fail('BUDGET_EXCEEDED', 'Job capability limit reached');
            const delta: any = { tools: [], services: [], binding: false };
            if (row.kind === 'plugin') {
                const existing = this.host.bindings(current).find(b => b.pluginId === row.asset_key);
                if (existing && existing.pluginVersion !== row.version) fail('CONFLICT', 'Uninstall the prior market version before installing another');
                if (!existing) { current.plugins = [...current.plugins ?? [], { pluginId: row.asset_key, pluginVersion: row.version, config }]; delta.binding = true; }
                const grants = release.data.grants as MarketGrants;
                if (this.audience(freshOwner, current, grants)) { delta.tools = grants.toolRefs.filter(t => !current.allowedTools.includes(t)); delta.services = grants.services.filter(s => !current.servicePermissions?.includes(s)); current.allowedTools = [...current.allowedTools, ...delta.tools]; current.servicePermissions = [...current.servicePermissions ?? [], ...delta.services]; }
                await this.host.validateAgent(current);
                await client.query('UPDATE agents SET data=$2 WHERE id=$1', [agentId, JSON.stringify(current)]);
            }
            await client.query('INSERT INTO market_installations(asset_id,agent_id,company_id,owner_id,active,data) VALUES($1,$2,$3,$4,true,$5) ON CONFLICT(asset_id,agent_id) DO UPDATE SET active=true,data=EXCLUDED.data,owner_id=EXCLUDED.owner_id', [id, agentId, owner.companyId, owner.id, JSON.stringify({ delta, installedBy: actor.id, releaseDigest: row.digest })]);
            await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'market.installed', JSON.stringify({ principalId: actor.id, companyId: owner.companyId, agentId, assetId: id, digest: row.digest })]);
            await client.query('COMMIT'); return { installed: true, release: this.dto(row), agentId, refreshConnection: row.kind === 'plugin' };
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    async installed(principalId: string, agentId: string) {
        const { actor, agent } = await this.host.authorize(principalId, agentId, 'read');
        if (actor.id !== agent.ownerId && actor.role !== 'admin') fail('PERMISSION_DENIED', 'Capability inventory is private to the job');
        const rows = (await this.host.db.pool.query('SELECT a.* FROM market_installations i JOIN market_assets a ON a.id=i.asset_id WHERE i.agent_id=$1 AND i.active=true ORDER BY a.created_at', [agentId])).rows;
        const items=[];for(const row of rows)if(this.visible(actor,row)&&await this.sourceVisible(actor.id,row))items.push(this.dto(row));return{items};
    }
    async skill(principalId: string, agentId: string, id: string, offset = 0,path='SKILL.md') {
        const { actor, agent } = await this.host.authorize(principalId, agentId);
        if (actor.id !== agent.ownerId && actor.role !== 'admin') fail('PERMISSION_DENIED', 'Read installed skills only for your job');
        const row = await this.row(actor, id);
        if (row.state !== 'published') fail('CONFLICT', 'Skill release was suspended');
        if (row.kind !== 'skill' || !(await this.host.db.pool.query('SELECT 1 FROM market_installations WHERE asset_id=$1 AND agent_id=$2 AND active=true', [id, agentId])).rowCount) fail('PERMISSION_DENIED', 'Skill is not installed on this job');
        const resource = await this.host.resources.read(actor.id, row.data.resourceRef.id, row.data.resourceRef.version, offset, 8000);
        let markdown=resource.body,nextOffset=resource.nextOffset;
        if(path!=='SKILL.md'){const file=await this.packageFile(row,path,offset);markdown=file.text;nextOffset=file.nextOffset;}
        const {body,...metadata}=resource;
        return { ...this.dto(row), markdown,path,files:row.data.files.map((f:any)=>({path:f.path,bytes:f.bytes})),resource:metadata, resourceRef: { id: resource.id, version: resource.version }, nextOffset, digest: resource.digest };
    }
    async granted(actor: Actor, agent: Agent, permission: string, toolRef?: string) {
        const owner = actor.id === agent.ownerId ? actor : await this.actor(agent.ownerId);
        const rows = (await this.host.db.pool.query("SELECT a.*,i.owner_id AS installation_owner FROM market_installations i JOIN market_assets a ON a.id=i.asset_id WHERE i.agent_id=$1 AND i.active=true AND a.company_id=$2 AND a.kind='plugin' AND a.state='published'", [agent.id, owner.companyId])).rows;
        return rows.some(row => row.installation_owner === agent.ownerId && this.visible(owner, row) && this.host.bindings(agent).some(b => b.pluginId === row.asset_key && b.pluginVersion === row.version) && (!toolRef || toolRef.startsWith(row.asset_key + ':')) && this.audience(owner, agent, row.data.grants) && (permission.startsWith('tool.invoke:') ? row.data.grants.toolRefs.includes(permission.slice('tool.invoke:'.length)) : row.data.grants.services.includes(permission)));
    }
    async guardTool(actor: Actor, agent: Agent, toolRef: string) {
        const binding = this.host.bindings(agent).find(b => toolRef.startsWith(b.pluginId + ':')); if (!binding) return;
        const releases=(await this.host.db.pool.query("SELECT * FROM market_assets WHERE kind='plugin' AND asset_key=$1 AND version=$2 AND data ? 'publishedBy'",[binding.pluginId,binding.pluginVersion])).rows;
        if(!releases.length)return;
        const rows = (await this.host.db.pool.query('SELECT a.*,i.owner_id AS installation_owner FROM market_installations i JOIN market_assets a ON a.id=i.asset_id WHERE i.agent_id=$1 AND i.active=true AND a.asset_key=$2 AND a.version=$3', [agent.id, binding.pluginId, binding.pluginVersion])).rows;
        const owner = actor.id === agent.ownerId ? actor : await this.actor(agent.ownerId);
        if(!rows.length||rows.some(row => row.company_id!==agent.companyId||row.installation_owner !== agent.ownerId || row.state !== 'published' || !this.visible(owner, row)||!this.audience(owner,agent,row.data.grants)&&!!(row.data.grants.principalIds.length||row.data.grants.presetIds.length||row.data.grants.departmentIds.length||row.data.grants.allCompany))) fail('PLUGIN_UNAVAILABLE', 'Mounted market release is suspended or outside current scope');
    }
    async plugins(principalId:string){
        const actor=await this.actor(principalId),rows=(await this.host.db.pool.query("SELECT * FROM market_assets WHERE kind='plugin' AND data ? 'publishedBy'")).rows;
        return this.host.registry.list().filter(plugin=>{const origins=rows.filter(row=>row.asset_key===plugin.id&&row.version===plugin.version);return !origins.length||origins.some(row=>row.company_id===actor.companyId&&(actor.role==='admin'||row.state==='published'&&this.visible(actor,row)));}).map(({directory,...plugin})=>plugin);
    }
    async assertActivation(principalId:string,pluginId:string,version:string){
        const actor=await this.actor(principalId),origins=(await this.host.db.pool.query("SELECT * FROM market_assets WHERE kind='plugin' AND asset_key=$1 AND version=$2 AND data ? 'publishedBy'",[pluginId,version])).rows;
        if(origins.length&&!origins.some(row=>row.state==='published'&&this.visible(actor,row)))fail('PLUGIN_UNAVAILABLE','Market plugin execution is outside the current publication scope');
    }
    async guardGlobalState(pluginId:string,version:string){if((await this.host.db.pool.query("SELECT 1 FROM market_assets WHERE kind='plugin' AND asset_key=$1 AND version=$2 AND data ? 'publishedBy'",[pluginId,version])).rowCount)fail('PERMISSION_DENIED','Change a company market release through its publication controls, not the shared runtime switch');}
    async uninstall(principalId: string, id: string, agentId: string) {
        const { actor, agent } = await this.host.authorize(principalId, agentId); requireUuid(id);
        if (actor.id !== agent.ownerId && actor.role !== 'admin') fail('PERMISSION_DENIED', 'Remove capabilities only from your own job');
        const client = await this.host.db.pool.connect();
        try {
            await client.query('BEGIN'); await this.host.organization.lock(client);
            const current = (await client.query('SELECT data FROM agents WHERE id=$1 FOR UPDATE', [agentId])).rows[0].data as Agent;
            if (contentHash(current) !== contentHash(agent) || this.host.hasActiveInvocation(agentId) || (await client.query("SELECT 1 FROM runs WHERE agent_id=$1 AND state='running'", [agentId])).rowCount) fail('CONFLICT', 'Finish the active turn before changing capabilities');
            const installed = (await client.query('SELECT i.*,a.asset_key FROM market_installations i JOIN market_assets a ON a.id=i.asset_id WHERE i.agent_id=$1 AND i.asset_id=$2 FOR UPDATE OF i', [agentId, id])).rows[0];
            if (!installed || installed.company_id !== actor.companyId) fail('NOT_FOUND', 'Installed capability is unavailable');
            if (installed.active) {
                const delta = installed.data.delta;
                if (delta.binding) current.plugins = current.plugins?.filter(b => b.pluginId !== installed.asset_key);
                current.allowedTools = current.allowedTools.filter(t => !delta.tools.includes(t)); current.servicePermissions = current.servicePermissions?.filter(p => !delta.services.includes(p));
                await client.query('UPDATE agents SET data=$2 WHERE id=$1', [agentId, JSON.stringify(current)]);
                await client.query('UPDATE market_installations SET active=false WHERE asset_id=$1 AND agent_id=$2', [id, agentId]);
                await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'market.uninstalled', JSON.stringify({ principalId: actor.id, companyId: actor.companyId, agentId, assetId: id })]);
            }
            await client.query('COMMIT'); return { installed: false, agentId, assetId: id, refreshConnection: true };
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    registerRoutes(app: FastifyInstance) {
        const principal = async (request: any) => (await authenticateRequest(this.host, request)).id;
        app.post('/v1/market/submissions', { bodyLimit: 8000000, schema: { body: marketInputSchema } }, async (request, reply) => reply.code(201).send(await this.submit(await principal(request), request.body as MarketInput)));
        app.get('/v1/market/submissions', async request => this.submissions(await principal(request)));
        app.get<{ Params: { id: string } }>('/v1/market/submissions/:id', async request => this.get(await principal(request), request.params.id));
        app.get<{Params:{id:string}}>('/v1/market/submissions/:id/file',async request=>{const q=request.query as any;return this.file(await principal(request),request.params.id,q.path,Number(q.offset??0));});
        app.get<{Params:{id:string}}>('/v1/market/submissions/:id/history',async request=>this.history(await principal(request),request.params.id));
        app.post<{ Params: { id: string } }>('/v1/market/submissions/:id/review', { schema: { body: { ...changeSchema, required: [...changeSchema.required, 'decision'], properties: { ...changeSchema.properties, decision: { enum: ['approve', 'reject'] } } } } }, async request => this.review(await principal(request), request.params.id, request.body as any));
        app.post<{ Params: { id: string } }>('/v1/market/submissions/:id/publish', { schema: { body: publishSchema } }, async request => this.publish(await principal(request), request.params.id, request.body as any));
        app.get('/v1/market/releases', async request => this.releases(await principal(request), (request.query as any).query ?? ''));
        app.get<{Params:{id:string}}>('/v1/market/releases/:id',async request=>this.release(await principal(request),request.params.id));
        app.post<{ Params: { id: string } }>('/v1/market/releases/:id/install', { schema: { body: { type: 'object', additionalProperties: false, required: ['agentId'], properties: { agentId: { type: 'string', maxLength: 64 }, config: { type: 'object' } } } } }, async request => this.install(await principal(request), request.params.id, (request.body as any).agentId, (request.body as any).config));
        app.post<{ Params: { id: string } }>('/v1/market/releases/:id/uninstall', { schema: { body: { type: 'object', additionalProperties: false, required: ['agentId'], properties: { agentId: { type: 'string', maxLength: 64 } } } } }, async request => this.uninstall(await principal(request), request.params.id, (request.body as any).agentId));
        app.put<{ Params: { id: string } }>('/v1/market/releases/:id/state', { schema: { body: { ...changeSchema, required: [...changeSchema.required, 'state'], properties: { ...changeSchema.properties, state: { enum: ['published', 'suspended'] } } } } }, async request => this.state(await principal(request), request.params.id, request.body as any));
        app.get<{ Params: { agentId: string } }>('/v1/agents/:agentId/market', async request => this.installed(await principal(request), request.params.agentId));
        app.get<{ Params: { agentId: string; id: string } }>('/v1/agents/:agentId/skills/:id', async request => this.skill(await principal(request), request.params.agentId, request.params.id, Number((request.query as any).offset ?? 0),(request.query as any).path??'SKILL.md'));
    }
}
