import { test, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

test('a company release targets public HTTPS without embedding development paths or credentials',async()=>{
    const { companyReleaseConfig } = await import('../scripts/company-release-config.mjs');
    const config=companyReleaseConfig({serverURL:'https://sales.hongkeweilai.com:8443/',dataNamespace:'cloud-v04-test',version:'0.4.1'});
    expect(config).toEqual({version:'0.4.1',serverURL:'https://sales.hongkeweilai.com:8443',dataNamespace:'cloud-v04-test'});
    expect(companyReleaseConfig({serverURL:'https://example.com/v07/',dataNamespace:'test',version:'0.7.0'}).serverURL).toBe('https://example.com/v07');
    for(const serverURL of ['http://192.168.1.3:4417','https://user:password@example.com','https://example.com/unsafe%2fpath','https://example.com/?token=x'])expect(()=>companyReleaseConfig({serverURL,dataNamespace:'test',version:'0.4.1'})).toThrow();
    expect(()=>companyReleaseConfig({serverURL:'https://example.com',dataNamespace:'../old',version:'0.4.1'})).toThrow();
    expect(()=>companyReleaseConfig({serverURL:'https://example.com',dataNamespace:'test',version:'../other'})).toThrow();
});

test('portable studio packaging preserves the reviewed UI and copies a self-contained runtime without development identity',async()=>{
    const {stageCompanyApplication}=await import('../scripts/company-package-stage.mjs');
    await mkdir('.test-data',{recursive:true});const base=await mkdtemp(resolve('.test-data/portable-company-'));
    const source=join(base,'source'),runtime=join(base,'runtime'),application=join(base,'package/resources/app');
    for(const dir of ['lib','welcome','packages/harness-workspace/lib','assets'])await mkdir(join(source,dir),{recursive:true});
    await mkdir(runtime);await writeFile(join(runtime,'runtime.txt'),'pinned runtime');
    await writeFile(join(source,'lib/company-main.mjs'),'reviewed company main');
    await writeFile(join(source,'welcome/welcome.css'),'body{font-size:16px}');
    await writeFile(join(source,'packages/harness-workspace/lib/client.js'),'reviewed v06 client');
    await writeFile(join(source,'assets/icon.ico'),'brand icon');
    await writeFile(join(source,'package.json'),JSON.stringify({name:'fixture',version:'0.6.0',main:'lib/company-main.mjs'}));
    await writeFile(join(source,'company.json'),JSON.stringify({version:'0.6.0',productName:'同舟',integratedChrome:true,dataDir:'PRIVATE_DEVICE_DIRECTORY',resourcesRoot:'PRIVATE_RUNTIME_DIRECTORY'}));
    await writeFile(join(source,'.env'),'SHOULD_NOT_SHIP=fixture');
    await writeFile(join(source,'identity.json'),'PRIVATE_IDENTITY');
    const config=await stageCompanyApplication({source,application,runtime,release:{serverURL:'http://127.0.0.1:55061',dataNamespace:'preview-v06',version:'0.6.0'}});
    expect(config).toEqual({version:'0.6.0',serverURL:'http://127.0.0.1:55061',dataNamespace:'preview-v06',productName:'同舟',integratedChrome:true});
    expect(JSON.parse(await readFile(join(application,'company.json'),'utf8'))).toEqual(config);
    expect(await readFile(join(application,'assets/icon.ico'),'utf8')).toBe('brand icon');
    expect(await readFile(join(application,'dsh/runtime.txt'),'utf8')).toBe('pinned runtime');
    expect(await readFile(join(application,'packages/harness-workspace/lib/client.js'),'utf8')).toBe('reviewed v06 client');
    expect(await readdir(application)).not.toContain('identity.json');expect(await readdir(application)).not.toContain('.env');
    await expect(stageCompanyApplication({source,application:join(base,'wrong'),runtime,release:{version:'0.4.0'}})).rejects.toThrow(/version/i);
});
