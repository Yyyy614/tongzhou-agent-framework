import{test,expect}from'vitest';import{mkdir,mkdtemp}from'node:fs/promises';import{resolve}from'node:path';
import{createFramework}from'../src/index.js';import{createServer}from'../src/server.js';

test('studio is an explicit isolated UI profile, with real existing API routes and deployment-scoped assets',async()=>{
    await mkdir('.test-data',{recursive:true});const host=await createFramework({root:await mkdtemp(resolve('.test-data/studio-web-'))});
    const classic=await createServer(host),studio=await createServer(host,{webProfile:'studio',publicBasePath:'/test'} as any);
    try{
        const old=(await classic.inject('/')).body;expect(old).not.toContain('company-theme.css');
        const page=await studio.inject('/');expect(page.body).toContain('/test/assets/company-theme.css');expect(page.body).toContain('/test/assets/company-tokens.css');
        expect((await studio.inject('/assets/app.js')).body).toContain('studio-overview');
        expect((await studio.inject('/assets/company-theme.css')).statusCode).toBe(200);
        expect((await studio.inject('/assets/base-views.js')).statusCode).toBe(200);
        expect((await studio.inject('/assets/ui.js')).body).toContain('baseModal');
        expect((await classic.inject('/assets/ui.js')).body).not.toContain('baseModal');
        expect((await classic.inject('/assets/company-theme.css')).statusCode).toBe(404);
        expect((await studio.inject('/v1/admin/employees')).statusCode).toBe(401);
        expect((await studio.inject('/health')).json().status).toBe('ok');
    }finally{await studio.close();await classic.close();await host.close();}
});
