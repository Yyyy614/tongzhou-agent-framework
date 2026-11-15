import { test, expect } from 'vitest';
import { mkdir, mkdtemp, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';

test('employees submit private candidates and install only reviewed, published skills within company scope', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/market-')) });
    let app: any;
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        for (const [id, role, companyId] of [['alice', 'employee', 'one'], ['bob', 'employee', 'one'], ['admin', 'admin', 'one'], ['outside', 'admin', 'two']] as const)
            await host.putActor({ id, role, companyId, permissions: [] });
        await host.putAgent({ id: 'bob-job', ownerId: 'bob', companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        await host.writeMemory({ principalId: 'bob', agentId: 'bob-job', noteId: 'INDEX', expectedVersion: 0, markdown: 'Keep my private memory', sourceRefs: [] });
        app = await createServer(host);
        const headers: Record<string, any> = {}; for (const id of ['alice', 'bob', 'admin', 'outside']) headers[id] = { authorization: 'Bearer ' + await host.issueAccessToken(id) };
        const api = (actor: string, url: string, method: any = 'GET', payload?: unknown) => app.inject({ url, method, payload, headers: headers[actor] });
        const payload = { assetKey: 'evidence-review', name: '通用证据核对', summary: '按来源逐项核对，缺失资料明确说明', version: '0.1.0', kind: 'skill', scope: 'company', files: [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: evidence-review\ndescription: 核对当前工作的证据和未决问题\n---\n只读取当前工作所需资料。必须引用来源；缺资料时不要编造。').toString('base64') },{path:'references/checklist.md',contentBase64:Buffer.from('Only include evidence actually read.').toString('base64')}], idempotencyKey: 'skill-one' };
        const uploaded = await api('alice', '/v1/market/submissions', 'POST', payload);
        expect(uploaded.statusCode).toBe(201); const item = uploaded.json();
        expect(item.state).toBe('submitted'); expect(item.checks.passed).toBe(true);
        const preview=await api('admin','/v1/market/submissions/'+item.id+'/file?path=SKILL.md');
        expect(preview.statusCode).toBe(200);expect(preview.json().text).toContain('不要编造');
        expect((await api('bob','/v1/market/submissions/'+item.id+'/file?path=SKILL.md')).statusCode).toBe(404);
        expect((await api('bob', '/v1/market/releases')).json().items).toEqual([]);
        expect((await api('outside', '/v1/market/submissions/' + item.id)).statusCode).toBe(404);
        expect((await api('bob', '/v1/market/releases/' + item.id + '/install', 'POST', { agentId: 'bob-job' })).statusCode).toBe(409);
        expect((await api('alice', '/v1/market/submissions/' + item.id + '/review', 'POST', { revision: item.revision, decision: 'approve', reason: 'self' })).statusCode).toBe(403);
        const reviewed = await api('admin', '/v1/market/submissions/' + item.id + '/review', 'POST', { revision: item.revision, decision: 'approve', reason: '用途与来源检查通过' });
        expect(reviewed.statusCode).toBe(200); expect(reviewed.json().state).toBe('approved');
        const published = await api('admin', '/v1/market/submissions/' + item.id + '/publish', 'POST', { revision: reviewed.json().revision, reason: '公司隔离试用' });
        expect(published.statusCode).toBe(200); expect(published.json().state).toBe('published');
        expect((await api('bob', '/v1/market/releases?query=证据')).json().items[0].id).toBe(item.id);
        const installed = await api('bob', '/v1/market/releases/' + item.id + '/install', 'POST', { agentId: 'bob-job' });
        expect(installed.statusCode).toBe(200);
        const skill = await api('bob', '/v1/agents/bob-job/skills/' + item.id);
        expect(skill.statusCode).toBe(200); expect(skill.json().markdown).toContain('不要编造'); expect(skill.json().version).toBe('0.1.0');
        expect((await api('bob','/v1/agents/bob-job/skills/'+item.id+'?path=references%2Fchecklist.md')).json().markdown).toBe('Only include evidence actually read.');
        expect((await api('bob','/v1/agents/bob-job/skills/'+item.id+'?path=..%2Fprivate')).statusCode).toBe(404);
        expect((await host.readMemory({ principalId: 'bob', agentId: 'bob-job', noteId: 'INDEX' })).markdown).toBe('Keep my private memory');
        expect((await api('outside', '/v1/market/releases')).json().items).toEqual([]);
        const conflict = await api('alice', '/v1/market/submissions', 'POST', { ...payload, idempotencyKey: 'changed', files: [{ path: 'SKILL.md', contentBase64: Buffer.from('changed').toString('base64') }] });
        expect(conflict.statusCode).toBe(409);
        const suspended = await api('admin', '/v1/market/releases/' + item.id + '/state', 'PUT', { revision: published.json().revision, state: 'suspended', reason: '停止试用' });
        expect(suspended.statusCode).toBe(200);
        expect((await api('bob', '/v1/agents/bob-job/skills/' + item.id)).statusCode).toBe(409);
        expect((await api('bob', '/v1/market/releases')).json().items).toEqual([]);
    } finally { await app?.close(); await host.close(); }
});

test('concurrent first submissions cannot create two maintainers for one capability namespace',async()=>{
    await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/market-race-'))}),app=await createServer(host);
    let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const query=host.db.pool.query.bind(host.db.pool);let reads=0;
    try{
        for(const id of ['alice','bob'])await host.putActor({id,companyId:'one',role:'employee',permissions:[]});
        (host.db.pool as any).query=async(sql:any,...args:any[])=>{const result=await(query as any)(sql,...args);if(typeof sql==='string'&&sql.startsWith('SELECT * FROM market_assets WHERE company_id=$1 AND asset_key=$2 ORDER BY created_at')){reads++;if(reads===2)release();await gate;}return result;};
        const files=[{path:'SKILL.md',contentBase64:Buffer.from('---\nname: shared-method\ndescription: Generic shared method\n---\nCheck evidence.').toString('base64')}];
        const responses=await Promise.all(['alice','bob'].map(async(id,index)=>app.inject({url:'/v1/market/submissions',method:'POST',headers:{authorization:'Bearer '+await host.issueAccessToken(id)},payload:{assetKey:'shared-method',name:'Shared method',summary:'Generic capability namespace',kind:'skill',scope:'company',version:'0.'+(index+1)+'.0',files,idempotencyKey:id}})));
        expect(responses.map(r=>r.statusCode).sort()).toEqual([201,403]);
        expect((await host.db.pool.query("SELECT DISTINCT owner_id FROM market_assets WHERE asset_key='shared-method'")).rowCount).toBe(1);
    }finally{release();await app.close();await host.close();}
});

test('plugin candidates never execute on upload or review, and approved per-job grants are revocable without changing employee permissions', async () => {
    await mkdir('.test-data', { recursive: true }); const root = await mkdtemp(resolve('.test-data/market-plugin-'));
    const host = await createFramework({ root }); let app: any;
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        for (const [id, role] of [['alice', 'employee'], ['bob', 'employee'], ['admin', 'admin']] as const) await host.putActor({ id, role, companyId: 'one', permissions: [] });
        await host.putAgent({ id: 'bob-job', ownerId: 'bob', companyId: 'one', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: [] });
        app = await createServer(host); const headers: Record<string, any> = {};
        for (const id of ['alice', 'bob', 'admin']) headers[id] = { authorization: 'Bearer ' + await host.issueAccessToken(id) };
        const api = (actor: string, url: string, method: any = 'GET', payload?: unknown) => app.inject({ url, method, payload, headers: headers[actor] });
        const marker = resolve(root, 'candidate-must-not-run.txt'), key = '@validation/generic-echo', tool = key + ':echo';
        const schema = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } };
        const manifest = { schemaVersion: '0.1.0', id: key, version: '0.1.0', engine: { framework: '^0.1.0', protocol: '1.0' }, entry: { kind: 'module', path: './plugin.mjs' }, permissions: [], provides: { tools: [{ id: 'echo', inputSchema: './input.json', outputSchema: './output.json', effect: 'read' }], presets: [], events: [] }, configSchema: './config.json', dependencies: [] };
        const files = { 'agent-plugin.json': JSON.stringify(manifest), 'input.json': JSON.stringify(schema), 'output.json': JSON.stringify(schema), 'config.json': JSON.stringify({ type: 'object', additionalProperties: false }), 'plugin.mjs': "import{writeFile}from'node:fs/promises';await writeFile(" + JSON.stringify(marker) + ", 'loaded');export function apply(ctx){ctx.tools.register('echo',async input=>({text:input.text.trim().toUpperCase()}));}" };
        const uploaded = await api('alice', '/v1/market/submissions', 'POST', { assetKey: key, name: '通用格式插件', summary: '仅处理传入的文字', version: '0.1.0', kind: 'plugin', scope: 'company', files: Object.entries(files).map(([path, content]) => ({ path, contentBase64: Buffer.from(content).toString('base64') })), idempotencyKey: 'plugin-one' });
        expect(uploaded.statusCode).toBe(201); expect(uploaded.json().checks.passed).toBe(true);
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' }); expect(host.registry.list().some(p => p.id === key)).toBe(false);
        const item = uploaded.json(), reviewed = await api('admin', '/v1/market/submissions/' + item.id + '/review', 'POST', { revision: item.revision, decision: 'approve', reason: '已核对来源与无副作用的工具实现' });
        const published = await api('admin', '/v1/market/submissions/' + item.id + '/publish', 'POST', { revision: reviewed.json().revision, reason: '仅向测试岗位开放', grants: { principalIds: ['bob'], presetIds: [], departmentIds: [], toolRefs: [tool], services: [] } });
        expect(published.statusCode).toBe(200); await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        await host.putActor({id:'outside',companyId:'two',role:'admin',permissions:[]});
        const otherHeaders={authorization:'Bearer '+await host.issueAccessToken('outside')};
        expect(JSON.stringify((await app.inject({url:'/v1/plugins',headers:otherHeaders})).json())).not.toContain(key);
        await host.putAgent({id:'outside-job',ownerId:'outside',companyId:'two',pluginId:key,pluginVersion:'0.1.0',allowedTools:[tool]});
        await expect(host.invoke({principalId:'outside',agentId:'outside-job',toolRef:tool,input:{text:'cross-company'},idempotencyKey:'blocked'})).rejects.toMatchObject({code:'PLUGIN_UNAVAILABLE'});
        expect((await api('bob', '/v1/market/releases/' + item.id + '/install', 'POST', { agentId: 'bob-job' })).statusCode).toBe(200);
        expect((await api('admin','/v1/admin/agents')).json().find((a:any)=>a.id==='bob-job').effectiveTools).toContain(tool);
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        const called = await host.invoke({ principalId: 'bob', agentId: 'bob-job', toolRef: tool, input: { text: ' actual business independent capability ' }, idempotencyKey: 'first' });
        expect(called.output).toEqual({ text: 'ACTUAL BUSINESS INDEPENDENT CAPABILITY' }); await expect(access(marker)).resolves.toBeUndefined();
        expect((await host.db.get<any>('actors', 'bob')).permissions).toEqual([]);
        const disabled = await api('admin', '/v1/market/releases/' + item.id + '/state', 'PUT', { revision: published.json().revision, state: 'suspended', reason: '撤回测试发布' }); expect(disabled.statusCode).toBe(200);
        await expect(host.invoke({ principalId: 'bob', agentId: 'bob-job', toolRef: tool, input: { text: 'must not execute' }, idempotencyKey: 'disabled' })).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' });
        const restored = await api('admin', '/v1/market/releases/' + item.id + '/state', 'PUT', { revision: disabled.json().revision, state: 'published', reason: '恢复已审查版本' }); expect(restored.statusCode).toBe(200);
        expect((await api('bob', '/v1/market/releases/' + item.id + '/uninstall', 'POST', { agentId: 'bob-job' })).statusCode).toBe(200);
        await expect(host.invoke({ principalId: 'bob', agentId: 'bob-job', toolRef: tool, input: { text: 'not mounted' }, idempotencyKey: 'uninstalled' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    } finally { await app?.close(); await host.close(); }
});
