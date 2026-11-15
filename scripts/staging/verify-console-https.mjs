import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const entry = JSON.parse(await readFile('.local/staging/private/https-console-probe.json','utf8'));
const url = new URL(entry.url), origin = url.origin;
assert.equal(origin, 'https://sales.hongkeweilai.com:8443');
const code = new URLSearchParams(url.hash.slice(1)).get('entry');
const login = await fetch(origin + '/console/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({code}) });
assert.equal(login.status,200);
const setCookie = login.headers.get('set-cookie');
assert(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict') && setCookie.includes('; Secure'));
const cookie = setCookie.split(';')[0];
const headers = { cookie };
try {
    const me = await fetch(origin + '/console/me', { headers }).then(r=>r.json());
    assert.equal(me.id,'admin'); assert.equal(me.role,'admin');
    const forged = await fetch(origin + '/console/logout', { method:'POST', headers: {cookie, origin:'https://foreign.example'} });
    assert.equal(forged.status,403);
    const anonymous = await fetch(origin + '/v1/admin/employee-client', {method:'HEAD'});
    assert.equal(anonymous.status,401);
    const download = await fetch(origin + '/v1/admin/employee-client', {method:'HEAD',headers});
    assert.equal(download.status,200); assert.equal(download.headers.get('content-type'),'application/zip');
    const evidence = {testedAt:new Date().toISOString(),origin,secureCookie:true,adminAuthenticated:true,foreignOriginDenied:true,anonymousDownloadDenied:true,adminDownloadAvailable:true};
    await writeFile('.local/staging/console-https-smoke.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence));
} finally {
    const logout = await fetch(origin + '/console/logout', {method:'POST',headers:{cookie,origin}});
    assert.equal(logout.status,200);
}
