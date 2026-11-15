// Generic conformance fixtures only. Never connects to a business system.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { windowsProtection } from '../../client/credential-store.mjs';
import { companyFetch } from '../../client/company-fetch.mjs';
const origin = 'http://127.0.0.1:14317';
const admin = JSON.parse(await readFile('.local/staging/private/access.json', 'utf8')).admin;
const identity = JSON.parse(await readFile('.local/staging/employee-device/identity.json', 'utf8'));
assert.equal(identity.serverURL, origin);
const staff = await windowsProtection.decrypt(identity.encryptedToken);
async function call(path, method = 'GET', body, token = admin, status = 200) {
    const response = await companyFetch(origin, path, { method, body, token });
    const value = await response.json();
    assert.equal(response.status, status, path + ': ' + (value.error?.code ?? response.status));
    return value;
}
const boot = await call('/v1/employee/bootstrap', 'GET', undefined, staff);
assert.equal(boot.employee.id, 'stage-staff');
assert.deepEqual(boot.agents.map(a => a.id), ['stage-agent']);
if (process.argv.includes('--settle')) {
    const runPosition = process.argv.indexOf('--run-id');
    const runId = runPosition >= 0 ? process.argv[runPosition + 1] : undefined;
    assert(runId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(runId), '--settle requires the exact target --run-id');
    const run = await call('/v1/runs/' + runId, 'GET', undefined, staff);
    assert.equal(run.state, 'succeeded');
    assert.equal(run.agentId, 'stage-agent');
    assert.equal(run.principalId, 'stage-staff');
    assert.equal(run.source, 'harness-client');
    const usage = await call('/v1/agents/stage-agent/usage', 'GET', undefined, staff);
    const logs = await call('/v1/agents/stage-agent/logs', 'GET', undefined, staff);
    const records = usage.records.filter(r => r.runId === runId && r.measurement === 'provider');
    assert(records.length > 0, 'Native Harness must produce provider usage');
    assert(records.every(r => r.principalId === 'stage-staff' && r.agentId === 'stage-agent'));
    const succeeded = logs.find(l => l.type === 'run.succeeded' && l.data.runId === runId && l.data.source === 'harness-client');
    assert(succeeded, 'Native Harness turn must complete in the server ledger');
    for (const type of ['tool.succeeded', 'report.recorded']) assert(logs.some(l => l.type === type && l.data.runId === succeeded.data.runId));
    const peerUsage = await call('/v1/admin/usage?principalId=stage-peer');
    assert.equal(peerUsage.totals.requests, 0);
    const evidence = { testedAt: new Date().toISOString(), origin, employee: 'stage-staff', agent: 'stage-agent', runId: succeeded.data.runId, nativeTurnSucceeded: true, pluginReceipt: true, reportReceipt: true, usageRequests: records.length, inputTokens: records.reduce((n,r)=>n+r.inputTokens,0), outputTokens: records.reduce((n,r)=>n+r.outputTokens,0), peerUsageRequests: 0 };
    await writeFile('.local/staging/native-onboarding-smoke.json', JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
} else {
    const permissions = ['tool.invoke:@example/conformance:text.normalize', 'memory.self.read', 'memory.self.propose_write', 'report.self.write'];
    if (!(await call('/v1/admin/employees')).some(e => e.id === 'stage-peer')) await call('/v1/admin/employees', 'POST', { id: 'stage-peer', displayName: '隔离验证员工', role: 'employee', department: '框架验证', permissions }, admin, 201);
    if (!(await call('/v1/admin/agents')).some(a => a.id === 'stage-peer-agent')) await call('/v1/admin/agents', 'POST', { id: 'stage-peer-agent', displayName: '隔离验证岗位', ownerId: 'stage-peer', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: ['@example/conformance:text.normalize'], servicePermissions: permissions.slice(1), preset: { id: 'company-worker', version: '0.1.0' } }, admin, 201);
    const invitation = await call('/v1/admin/employees/stage-peer/invitations', 'POST', {}, admin, 201);
    const device = await call('/v1/employee/activate', 'POST', { code: invitation.code, deviceName: '临时隔离验证设备' }, undefined, 201);
    try {
        for (const [agentId, token, markdown] of [['stage-agent', staff, '# 私人索引\n本岗位的测试标记为“云端框架已接通”。只按需读取自己的笔记。'], ['stage-peer-agent', device.accessToken, '# 私人索引\n这是另一个员工的独立测试笔记。']]) {
            const notes = await call('/v1/agents/' + agentId + '/memory', 'GET', undefined, token);
            if (!notes.some(n => n.noteId === 'INDEX')) await call('/v1/agents/' + agentId + '/memory/INDEX', 'PUT', { markdown, expectedVersion: 0, sourceRefs: ['staging:conformance'] }, token);
            assert.equal((await call('/v1/agents/' + agentId + '/memory/INDEX', 'GET', undefined, token)).markdown, markdown);
        }
        await call('/v1/agents/stage-peer-agent/memory/INDEX', 'GET', undefined, staff, 403);
        await call('/v1/agents/stage-agent/memory/INDEX', 'GET', undefined, device.accessToken, 403);
        await call('/v1/admin/employees', 'GET', undefined, staff, 403);
        await call('/v1/employee/activate', 'POST', { code: invitation.code, deviceName: '重复激活' }, undefined, 401);
        const invocation = await call('/v1/invoke', 'POST', { agentId: 'stage-agent', toolRef: '@example/conformance:text.normalize', input: { text: '  云端   框架  ' }, idempotencyKey: randomUUID() }, staff);
        assert.equal(invocation.outcome, 'succeeded');
        assert.deepEqual(invocation.output, { text: '云端 框架' });
    } finally { await call('/v1/admin/employees/stage-peer/devices/' + device.deviceId, 'DELETE'); }
    await call('/v1/employee/bootstrap', 'GET', undefined, device.accessToken, 401);
    const evidence = { testedAt: new Date().toISOString(), employeeActivated: true, assignedPresetOnly: true, privateMemoryWritten: true, crossEmployeeMemoryDeniedBothWays: true, employeeAdminDenied: true, pluginInvocationPassed: true, invitationReuseDenied: true, peerDeviceRevocationPassed: true };
    await writeFile('.local/staging/isolation-smoke.json', JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
}
