import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Framework } from './index.js';
import { EmployeeDevices, credentialHash } from './employee-devices.js';
import { fail } from './errors.js';
// OWASP's 32 MiB scrypt profile; never store plaintext or fast password digests.
const params = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
let passwordWork = 0;
async function derive(password: string, salt: string) {
    if (passwordWork >= 2) fail('BUDGET_EXCEEDED', 'Login is busy; retry shortly');
    passwordWork++;
    try { return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, params, (e, key) => e ? reject(e) : resolve(key))); }
    finally { passwordWork--; }
}
async function encode(password: string) { const salt = randomBytes(24).toString('hex'); return 'scrypt-v1$' + salt + '$' + (await derive(password, salt)).toString('hex'); }
async function matches(password: string, encoded?: string) {
    const parts = encoded?.split('$');
    const valid = parts?.length === 3 && parts[0] === 'scrypt-v1' && /^[a-f0-9]{48}$/u.test(parts[1]!) && /^[a-f0-9]{128}$/u.test(parts[2]!);
    const key = await derive(password, valid ? parts![1]! : '000000000000000000000000000000000000000000000000');
    return !!valid && timingSafeEqual(key, Buffer.from(parts![2]!, 'hex'));
}
export function registerEmployeeAccounts(app: FastifyInstance, host: Framework, devices: EmployeeDevices) {
    // Persistent, atomic fixed windows also cover unknown usernames. Keys are
    // hashed, and SQL refuses attempts beyond the limit across host restarts.
    async function attempt(kind: string, value: string, limit: number) {
        const key = kind + ':' + credentialHash(value);
        const result = await host.db.pool.query(`INSERT INTO employee_login_limits(key,attempts,window_start) VALUES($1,1,now()) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN employee_login_limits.window_start<now()-interval '10 minutes' THEN 1 ELSE employee_login_limits.attempts+1 END,window_start=CASE WHEN employee_login_limits.window_start<now()-interval '10 minutes' THEN now() ELSE employee_login_limits.window_start END WHERE employee_login_limits.window_start<now()-interval '10 minutes' OR employee_login_limits.attempts<$2 RETURNING attempts`, [key, limit]);
        if (!result.rowCount) fail('BUDGET_EXCEEDED', 'Too many login attempts; retry later');
    }
    const deviceName = { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' };
    app.post<{ Body: { code: string; password: string; deviceName: string } }>('/v1/employee/register', { schema: { body: { type: 'object', additionalProperties: false, required: ['code', 'password', 'deviceName'], properties: { code: { type: 'string', minLength: 32, maxLength: 160 }, password: { type: 'string', minLength: 12, maxLength: 128 }, deviceName } } } }, async (request, reply) => {
        await attempt('register-ip', request.ip, 120);
        const codeExists = (await host.db.pool.query('SELECT 1 FROM employee_invitations WHERE hash=$1 AND expires_at>now()', [credentialHash(request.body.code)])).rowCount;
        if (!codeExists) fail('UNAUTHENTICATED', 'Activation code is invalid, used or expired');
        return reply.code(201).send(await devices.activate(request.body, await encode(request.body.password)));
    });
    app.post<{ Body: { username: string; password: string; deviceName: string } }>('/v1/employee/login', { schema: { body: { type: 'object', additionalProperties: false, required: ['username', 'password', 'deviceName'], properties: { username: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' }, password: { type: 'string', minLength: 1, maxLength: 128 }, deviceName } } } }, async (request, reply) => {
        await attempt('login-ip', request.ip, 120);
        await attempt('login-user', request.body.username, 10);
        const row = (await host.db.pool.query('SELECT c.password_hash FROM employee_credentials c JOIN actors a ON a.id=c.principal_id WHERE a.id=$1 AND a.data->>\'active\'=\'true\' AND a.data->>\'role\'=\'employee\'', [request.body.username])).rows[0];
        if (!(await matches(request.body.password, row?.password_hash))) fail('UNAUTHENTICATED', 'Account or password is incorrect');
        const result = await devices.login(request.body.username, row.password_hash, request.body.deviceName);
        return reply.code(201).send(result);
    });
}
