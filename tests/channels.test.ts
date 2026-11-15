import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer as httpServer } from 'node:http';
import { createFramework } from '../src/index.js';
import { createServer } from '../src/server.js';
test('channel credentials are write-only and account groups share concurrency while other accounts remain usable', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/channels-')) }); const app = await createServer(host);
    let release!: () => void; const pause = new Promise<void>(r => release = r); let started!: () => void; const entered = new Promise<void>(r => started = r);
    let activeRequest:Promise<any>|undefined;
    const received: string[] = []; const upstream = httpServer(async (req, res) => { const key = String(req.headers['x-api-key']); received.push(key); if (key === 'fixture-a') { started(); await pause; } res.setHeader('content-type', 'application/json');res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 }, content: [] })); });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r)); const port = (upstream.address() as any).port;
    try {
        await host.putActor({ id: 'admin', companyId: 'one', role: 'admin', permissions: [] }); await host.putActor({ id: 'staff', companyId: 'one', role: 'employee', permissions: [] });
        await host.putActor({ id: 'outside', companyId: 'two', role: 'admin', permissions: [] });
        const admin = { authorization: 'Bearer ' + await host.issueAccessToken('admin') }, staff = { authorization: 'Bearer ' + await host.issueAccessToken('staff') }, outside = { authorization: 'Bearer ' + await host.issueAccessToken('outside') };
        const payload = { id: 'a', name: '公司主账号', kind: 'model', protocol: 'anthropic', provider: 'fixture', baseURL: 'http://127.0.0.1:' + port, model: 'fixture-model', accountGroup: 'account-one', maxConcurrency: 1, priority: 1, scope: 'company', enabled: true, apiKey: 'fixture-a', documentation: '公司提供的通用模型接口。' };
        const response = await app.inject({ method: 'POST', url: '/v1/admin/channels', headers: admin, payload }); expect(response.statusCode).toBe(201); expect(response.body).not.toContain('fixture-a'); expect(response.json().hasCredential).toBe(true);
        expect((await app.inject({ method: 'POST', url: '/v1/admin/channels', headers: staff, payload: { ...payload, id: 'denied' } })).statusCode).toBe(403);
        expect((await app.inject({ url: '/v1/admin/channels', headers: outside })).json().channels).toHaveLength(0);
        for (const patch of [{ id: 'a2', name: '同账号备用Key', apiKey: 'fixture-a2', model: 'fixture-second-model' }, { id: 'b', name: '第二账号', apiKey: 'fixture-b', accountGroup: 'account-two', priority: 2, model: 'fixture-second-model' }]) expect((await app.inject({ method: 'POST', url: '/v1/admin/channels', headers: admin, payload: { ...payload, ...patch } })).statusCode).toBe(201);
        const first = activeRequest = host.channels.forward('staff', { model: 'fixture-model', max_tokens: 1, messages: [] }, new AbortController().signal);
        await entered;
        const second = await host.channels.forward('staff', { model: 'fixture-second-model', max_tokens: 1, messages: [] }, new AbortController().signal);
        expect(second.channelId).toBe('b'); release(); await first;
        expect(received).toEqual(['fixture-a', 'fixture-b']);
        const data = JSON.stringify((await host.db.pool.query('SELECT credential FROM provider_channels')).rows); expect(data).not.toContain('fixture-a');
        const catalog = await app.inject({ url: '/v1/connections', headers: staff }); expect(catalog.body).not.toContain('credential'); expect(catalog.json().items.some((c: any) => c.name === '公司主账号')).toBe(true);
    } finally { release(); if(activeRequest)await Promise.allSettled([activeRequest]);await app.close(); await host.close(); await new Promise<void>(r => upstream.close(() => r())); }
});

test('the existing environment key and a new key assigned to its account group use one shared slot', async () => {
    await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/environment-pool-'))}),app=await createServer(host);
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),pause=new Promise<void>(r=>release=r);let pending:Promise<any>|undefined;
    const used:string[]=[];const upstream=httpServer(async(req,res)=>{const key=String(req.headers['x-api-key']);used.push(key);if(key==='environment-fixture'){entered();await pause;}res.setHeader('content-type','application/json');res.end('{"usage":{"input_tokens":1,"output_tokens":1}}');});
    await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
    try{
        await host.putActor({id:'admin',companyId:'one',role:'admin',permissions:[]});for(const id of ['u','v'])await host.putActor({id,companyId:'one',role:'employee',permissions:[]});
        const baseURL='http://127.0.0.1:'+(upstream.address() as any).port;host.channels.configureFallback('environment-fixture',baseURL,'fixture-model');
        const prior=(await host.channels.list('admin',true))[0]!;
        const channel={id:'environment-default',name:'已有账号',kind:'model',protocol:'anthropic',provider:'deepseek',baseURL,model:'fixture-model',accountGroup:'shared-account',maxConcurrency:1,priority:1,scope:'company',enabled:true,revision:prior.revision};
        const headers={authorization:'Bearer '+await host.issueAccessToken('admin')};expect((await app.inject({method:'PUT',url:'/v1/admin/channels/environment-default',headers,payload:channel})).statusCode).toBe(200);
        const {revision,...newChannel}=channel;
        for(const patch of [{id:'other-key',name:'同账号另一Key',apiKey:'same-account-fixture',priority:2},{id:'another-account',name:'其他账号',apiKey:'other-account-fixture',accountGroup:'different-account',priority:3}])expect((await app.inject({method:'POST',url:'/v1/admin/channels',headers,payload:{...newChannel,...patch}})).statusCode).toBe(201);
        pending=host.channels.forward('u',{model:'fixture-model',messages:[],max_tokens:1},new AbortController().signal);await started;
        expect((await host.channels.forward('v',{model:'fixture-model',messages:[],max_tokens:1},new AbortController().signal)).channelId).toBe('another-account');
        release();await pending;expect(used).toEqual(['environment-fixture','other-account-fixture']);
    }finally{release();if(pending)await Promise.allSettled([pending]);await app.close();await host.close();await new Promise<void>(r=>upstream.close(()=>r()));}
});

test('only an explicit rejection fails over; an unknown response is never replayed, and encrypted keys survive restart', async () => {
    await mkdir('.test-data', { recursive: true }); const root=await mkdtemp(resolve('.test-data/channel-failover-'));
    let host=await createFramework({root}),app=await createServer(host);const received:string[]=[];
    const upstream=httpServer((req,res)=>{const key=String(req.headers['x-api-key']);received.push(key);if(key==='fixture-unknown'){req.socket.destroy();return;}res.setHeader('content-type','application/json');res.statusCode=key==='fixture-rejected'?429:200;res.end(JSON.stringify({usage:{input_tokens:1,output_tokens:1},content:[]}));});
    await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
    try{
        await host.putActor({id:'admin',companyId:'one',role:'admin',permissions:[]});await host.putActor({id:'staff',companyId:'one',role:'employee',permissions:[]});
        const headers={authorization:'Bearer '+await host.issueAccessToken('admin')};
        const channel={id:'first',name:'主渠道',kind:'model',protocol:'anthropic',provider:'fixture',baseURL:'http://127.0.0.1:'+(upstream.address() as any).port,model:'fixture-model',accountGroup:'one',maxConcurrency:1,priority:1,scope:'company',enabled:true,apiKey:'fixture-rejected'};
        for(const patch of [{},{id:'second',name:'备选渠道',accountGroup:'two',priority:2,apiKey:'fixture-second'}])expect((await app.inject({method:'POST',url:'/v1/admin/channels',headers,payload:{...channel,...patch}})).statusCode).toBe(201);
        const result=await host.channels.forward('staff',{model:'fixture-model',messages:[],max_tokens:1},new AbortController().signal);expect(result.channelId).toBe('second');expect(received).toEqual(['fixture-rejected','fixture-second']);
        const first=(await host.channels.list('admin',true)).find(c=>c.id==='first')!;
        const {hasCredential,cooldownUntil,lastStatus,activeRequests,accountActiveRequests,usage,...writable}=first;
        expect((await app.inject({method:'PUT',url:'/v1/admin/channels/first',headers,payload:{...writable,apiKey:'fixture-unknown'}})).statusCode).toBe(200);
        await expect(host.channels.forward('staff',{model:'fixture-model',messages:[],max_tokens:1},new AbortController().signal)).rejects.toMatchObject({code:'RESULT_UNKNOWN'});
        expect(received).toEqual(['fixture-rejected','fixture-second','fixture-unknown']);
        await app.close();await host.close();host=await createFramework({root});app=await createServer(host);
        expect((await host.channels.list('admin',true)).find(c=>c.id==='second')?.hasCredential).toBe(true);
        const same=(await host.channels.list('admin',true)).find(c=>c.id==='first')!;const {hasCredential:h,cooldownUntil:c,lastStatus:s,activeRequests:a,accountActiveRequests:aa,usage:u,...disable}=same;
        await host.channels.save('admin',{...disable,enabled:false},false);
        expect((await host.channels.forward('staff',{model:'fixture-model',messages:[],max_tokens:1},new AbortController().signal)).channelId).toBe('second');
        const originalAudit=host.db.audit.bind(host.db);host.db.audit=async(type,data)=>{if(type==='channel.request')throw Error('fixture persistence failure after response');return originalAudit(type,data);};
        try { await expect(host.channels.forward('staff',{model:'fixture-model',messages:[],max_tokens:1},new AbortController().signal)).rejects.toMatchObject({code:'RESULT_UNKNOWN'}); }
        finally { host.db.audit=originalAudit; }
    }finally{await app.close();await host.close();await new Promise<void>(r=>upstream.close(()=>r()));}
});
