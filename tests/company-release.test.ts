import { test, expect } from 'vitest';

test('a company release targets public HTTPS without embedding development paths or credentials',async()=>{
    const { companyReleaseConfig } = await import('../scripts/company-release-config.mjs');
    const config=companyReleaseConfig({serverURL:'https://sales.hongkeweilai.com:8443/',dataNamespace:'cloud-v04-test',version:'0.4.1'});
    expect(config).toEqual({version:'0.4.1',serverURL:'https://sales.hongkeweilai.com:8443',dataNamespace:'cloud-v04-test'});
    for(const serverURL of ['http://192.168.1.3:4417','https://user:password@example.com','https://example.com/path','https://example.com/?token=x'])expect(()=>companyReleaseConfig({serverURL,dataNamespace:'test',version:'0.4.1'})).toThrow();
    expect(()=>companyReleaseConfig({serverURL:'https://example.com',dataNamespace:'../old',version:'0.4.1'})).toThrow();
    expect(()=>companyReleaseConfig({serverURL:'https://example.com',dataNamespace:'test',version:'../other'})).toThrow();
});
