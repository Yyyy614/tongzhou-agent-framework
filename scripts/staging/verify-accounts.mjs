// Live conformance fixture, kept outside the employee distribution and kernel.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { windowsProtection } from '../../client/credential-store.mjs';
import { companyFetch } from '../../client/company-fetch.mjs';
const companyURL = 'https://sales.hongkeweilai.com:8443';
const privatePath = '.local/staging/private/account-conformance.json';
const primary = '.local/staging/https-employee-device';
const second = '.local/staging/https-second-device';
async function remote(origin, path, method, body, token, status = 200) {
    const response = await companyFetch(origin, path, { method, body, token });
    const value = await response.json();
    assert.equal(response.status, status, path + ': ' + (value.error?.code ?? response.status));
    return value;
}
async function local(dir, path, body, status = 200) {
    const control = JSON.parse(await readFile(resolve(dir, 'local-session.json'), 'utf8'));
    const response = await fetch(control.origin + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-client-session': control.session, origin: control.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, status, path);
    return value;
}
if (process.argv.includes('--prepare')) {
    // An operator may prepare the fixture over the original encrypted SSH
    // loopback while the public firewall rule is awaiting approval.
    const admin = JSON.parse(await readFile('.local/staging/private/access.json', 'utf8')).admin;
    const origin = 'http://127.0.0.1:14317';
    const username = 'pc-login-test', agentId = 'pc-login-agent';
    const permissions = ['tool.invoke:@example/conformance:text.normalize', 'memory.self.read', 'memory.self.propose_write', 'report.self.write'];
    if (!(await remote(origin, '/v1/admin/employees', 'GET', undefined, admin)).some(e => e.id === username)) await remote(origin, '/v1/admin/employees', 'POST', { id: username, displayName: '账号换机验证员工', department: '框架验证', role: 'employee', permissions }, admin, 201);
    if (!(await remote(origin, '/v1/admin/agents', 'GET', undefined, admin)).some(a => a.id === agentId)) await remote(origin, '/v1/admin/agents', 'POST', { id: agentId, displayName: '账号换机验证岗位', ownerId: username, pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: ['@example/conformance:text.normalize'], servicePermissions: permissions.slice(1), preset: { id: 'company-worker', version: '0.1.0' } }, admin, 201);
    const invitation = await remote(origin, '/v1/admin/employees/' + username + '/invitations', 'POST', {}, admin, 201);
    await writeFile(privatePath, JSON.stringify({ companyURL, username, agentId, password: randomBytes(24).toString('base64url'), code: invitation.code }), { mode: 0o600 });
    console.log('Generic account fixture prepared; credentials saved privately, not printed.');
} else {
    const fixture = JSON.parse(await readFile(privatePath, 'utf8'));
    if (process.argv.includes('--register')) {
        const state = await local(primary, 'register', { code: fixture.code, password: fixture.password, deviceName: '账号测试电脑A' }, 201);
        assert.equal(state.employee.id, fixture.username);
        assert.deepEqual(state.agents.map(a => a.id), [fixture.agentId]);
        console.log('First computer set a password and received only its assigned Agent.');
    } else if (process.argv.includes('--second')) {
        const state = await local(second, 'login', { username: fixture.username, password: fixture.password, deviceName: '账号测试电脑B' }, 201);
        assert.equal(state.employee.id, fixture.username);
        const [a,b] = await Promise.all([primary,second].map(async d => JSON.parse(await readFile(resolve(d, 'identity.json'), 'utf8'))));
        assert.equal(a.serverURL, companyURL); assert.equal(b.serverURL, companyURL);
        assert.notEqual(a.deviceId, b.deviceId);
        const [ta,tb] = await Promise.all([a,b].map(i => windowsProtection.decrypt(i.encryptedToken)));
        assert.notEqual(ta,tb);
        const markdown = '# Account memory\nSame employee, same Agent, across two clean device profiles.';
        const notes = await remote(companyURL, '/v1/agents/' + fixture.agentId + '/memory', 'GET', undefined, ta);
        if (!notes.some(n => n.noteId === 'INDEX')) await remote(companyURL, '/v1/agents/' + fixture.agentId + '/memory/INDEX', 'PUT', { markdown, expectedVersion: 0, sourceRefs: ['staging:account-conformance'] }, ta);
        assert.equal((await remote(companyURL, '/v1/agents/' + fixture.agentId + '/memory/INDEX', 'GET', undefined, tb)).markdown, markdown);
        await remote(companyURL, '/v1/agents/stage-peer-agent/memory/INDEX', 'GET', undefined, tb, 403);
        await remote(companyURL, '/v1/admin/employees', 'GET', undefined, tb, 403);
        const evidence = { testedAt: new Date().toISOString(), origin: companyURL, sameEmployee: fixture.username, sameAgent: fixture.agentId, distinctDeviceIds: true, distinctCredentials: true, samePrivateMemory: true, otherEmployeeMemoryDenied: true, employeeAdminDenied: true, profilesOnOnePhysicalComputer: true, physicalSecondComputerVerified: false };
        await writeFile('.local/staging/account-two-profiles-smoke.json', JSON.stringify(evidence,null,2));
        console.log(JSON.stringify(evidence));
    } else if (process.argv.includes('--native-run')) {
        const runId = process.argv[process.argv.indexOf('--native-run') + 1];
        assert(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(runId ?? ''), 'Provide the exact native run UUID');
        // Verify the first profile's native turn using the second profile's
        // independent credential, never a prior success or accumulated usage.
        const identity = JSON.parse(await readFile(resolve(second, 'identity.json'), 'utf8'));
        const token = await windowsProtection.decrypt(identity.encryptedToken);
        const run = await remote(companyURL, '/v1/runs/' + runId, 'GET', undefined, token);
        assert.equal(run.state, 'succeeded'); assert.equal(run.source, 'harness-client');
        assert.equal(run.agentId, fixture.agentId); assert.equal(run.principalId, fixture.username);
        assert(run.output.includes('账号 换机 接通'));
        const logs = await remote(companyURL, '/v1/agents/' + fixture.agentId + '/logs', 'GET', undefined, token);
        const events = logs.filter(l => l.data.runId === runId);
        for (const type of ['tool.succeeded','report.recorded']) assert(events.some(l => l.type === type));
        assert(events.some(l => l.type === 'runtime.tool_succeeded' && l.data.toolName === 'memory_read'));
        const records = (await remote(companyURL, '/v1/agents/' + fixture.agentId + '/usage', 'GET', undefined, token)).records.filter(r => r.runId === runId);
        assert(records.length > 0 && records.every(r => r.measurement === 'provider' && r.principalId === fixture.username && r.agentId === fixture.agentId));
        assert.equal((await remote(companyURL, '/v1/agents/' + fixture.agentId + '/memory/INDEX', 'GET', undefined, token)).version, 1);
        const evidence = { testedAt: new Date().toISOString(), origin: companyURL, runId, employee: fixture.username, agent: fixture.agentId, nativeTurnSucceeded: true, pluginReceipt: true, privateMemoryReadReceipt: true, reportReceipt: true, memoryUnchanged: true, secondProfileCanReadOwnAccountResult: true, requests: records.length, inputTokens: records.reduce((n,r)=>n+r.inputTokens,0), outputTokens: records.reduce((n,r)=>n+r.outputTokens,0), cacheReadTokens: records.reduce((n,r)=>n+(r.cacheReadTokens??0),0), physicalSecondComputerVerified: false };
        await writeFile('.local/staging/account-native-https-smoke.json', JSON.stringify(evidence,null,2));
        console.log(JSON.stringify(evidence));
    } else throw Error('Use --prepare, --register, --second or --native-run <UUID>');
}
