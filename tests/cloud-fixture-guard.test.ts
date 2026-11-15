import { test, expect } from 'vitest';

test('cloud provisioning refuses existing IDs without a completed ownership record before claiming any old data',async()=>{
    const { guardCloudFixture } = await import('../scripts/staging/cloud-fixture-guard.mjs');
    const settings={serverURL:'https://sales.hongkeweilai.com:8443',username:'harness-cloud-test',agentIds:['harness-cloud-documents','harness-cloud-inventory'],actorIds:['harness-cloud-test','harness-cloud-peer'],allAgentIds:['harness-cloud-documents','harness-cloud-inventory','harness-cloud-peer-agent']};
    expect(guardCloudFixture({...settings,employees:[],agents:[],account:null})).toEqual({mayCreateEmployee:true});
    const employees=[{id:'harness-cloud-test'}],agents=[];
    expect(()=>guardCloudFixture({...settings,employees,agents,account:null})).toThrow(/already exist/u);
    expect(()=>guardCloudFixture({...settings,employees,agents,account:{...settings,registered:false}})).toThrow(/ownership/u);
    expect(()=>guardCloudFixture({...settings,employees,agents,account:{...settings,registered:true,serverURL:'https://another.example'}})).toThrow(/ownership/u);
    expect(guardCloudFixture({...settings,employees,agents,account:{...settings,registered:true}})).toEqual({mayCreateEmployee:false});
});
