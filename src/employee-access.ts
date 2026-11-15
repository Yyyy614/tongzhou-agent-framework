import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Framework } from './index.js';
import type { Actor } from './types.js';
import { requireAdmin } from './admin.js';
import { authenticateRequest } from './console-auth.js';
import { fail } from './errors.js';
import { EmployeeDevices, readyEmployeeAgents as readyAgents } from './employee-devices.js';
import { registerEmployeeAccounts } from './employee-accounts.js';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, sep } from 'node:path';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bearer = (request: { headers: { authorization?: string } }) => request.headers.authorization?.replace(/^Bearer /u, '') ?? '';
async function target(host: Framework, administrator: string, employeeId: string) {
    const admin = await requireAdmin(host, administrator);
    const employee = await host.db.get<Actor>('actors', employeeId);
    if (employee.companyId !== admin.companyId) fail('PERMISSION_DENIED', 'Employee belongs to another company');
    return { admin, employee };
}
export function registerEmployeeAccess(app: FastifyInstance, host: Framework) {
    app.get('/v1/admin/employee-client', async (request, reply) => {
        await requireAdmin(host, (await authenticateRequest(host, request)).id);
        let release: { archivePath: string };
        try { release = JSON.parse(await readFile(resolve('.local/employee-client-release.json'), 'utf8')); }
        catch { fail('NOT_FOUND', 'Build the employee client release first'); }
        const path = resolve(release.archivePath);
        if (!path.startsWith(resolve('.local/employee-releases') + sep) || !path.endsWith('.zip')) fail('INVALID_INPUT', 'Invalid employee client release path');
        return reply.header('Content-Type', 'application/zip').header('Content-Disposition', 'attachment; filename="CompanyAgent-windows-x64.zip"').send(createReadStream(path));
    });
    app.post<{ Params: { id: string } }>('/v1/admin/employees/:id/invitations', { schema: { body: { type: 'object', additionalProperties: false, properties: {} } } }, async (request, reply) => {
        const signedIn = await authenticateRequest(host, request);
        const { admin } = await target(host, signedIn.id, request.params.id);
        const client = await host.db.pool.connect();
        try {
            await client.query('BEGIN');
            const employee = (await client.query('SELECT data FROM actors WHERE id=$1 FOR UPDATE', [request.params.id])).rows[0].data as Actor;
            if (!employee.active || employee.role !== 'employee') fail('PERMISSION_DENIED', 'Select an active employee account');
            if (!(await readyAgents(host, employee, client)).length) fail('INVALID_INPUT', 'Assign an active Harness Agent, preset and enabled plugins before inviting');
            const id = randomUUID(), code = 'fw_invite_' + randomBytes(32).toString('base64url');
            await client.query('DELETE FROM employee_invitations WHERE principal_id=$1', [employee.id]);
            const expiresAt = (await client.query("INSERT INTO employee_invitations(id,hash,principal_id,created_by,expires_at) VALUES($1,$2,$3,$4,now()+interval '24 hours') RETURNING expires_at", [id, hash(code), employee.id, admin.id])).rows[0].expires_at;
            await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'employee.invitation_created', JSON.stringify({ principalId: admin.id, companyId: admin.companyId, targetPrincipalId: employee.id, invitationId: id })]);
            await client.query('COMMIT');
            return reply.code(201).send({ id, code, employeeId: employee.id, expiresAt });
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    });
    const devices = new EmployeeDevices(host);
    registerEmployeeAccounts(app, host, devices);
    app.post<{ Body: { code: string; deviceName: string } }>('/v1/employee/activate', { schema: { body: { type: 'object', additionalProperties: false, required: ['code', 'deviceName'], properties: { code: { type: 'string', minLength: 32, maxLength: 160 }, deviceName: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' } } } } }, async (request, reply) => reply.code(201).send(await devices.activate(request.body)));
    app.get('/v1/employee/bootstrap', async request => {
        const employee = await authenticateRequest(host, request);
        return { employee: { id: employee.id, displayName: employee.displayName ?? employee.id, companyId: employee.companyId }, agents: (await readyAgents(host, employee)).map(a => ({ id: a.id, displayName: a.displayName ?? a.id, preset: a.preset, presetName: host.presets.get(a.preset!).name })) };
    });
    app.get<{ Params: { id: string } }>('/v1/admin/employees/:id/devices', async request => {
        await target(host, (await authenticateRequest(host, request)).id, request.params.id);
        return (await host.db.pool.query('SELECT id,name,expires_at AS "expiresAt",revoked_at AS "revokedAt",created_at AS "createdAt" FROM employee_devices WHERE principal_id=$1 ORDER BY created_at DESC LIMIT 100', [request.params.id])).rows;
    });
    async function revoke(principalId: string, tokenHash: string, deviceId: string) {
        const client = await host.db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM access_tokens WHERE hash=$1', [tokenHash]);
            await client.query('UPDATE employee_devices SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1', [deviceId]);
            await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'employee.device_revoked', JSON.stringify({ principalId, deviceId })]);
            await client.query('COMMIT');
            return { revoked: true };
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    app.delete<{ Params: { id: string; deviceId: string } }>('/v1/admin/employees/:id/devices/:deviceId', async request => {
        const signedIn = await authenticateRequest(host, request);
        await target(host, signedIn.id, request.params.id);
        const device = (await host.db.pool.query('SELECT token_hash FROM employee_devices WHERE id=$1 AND principal_id=$2', [request.params.deviceId, request.params.id])).rows[0];
        if (!device) fail('NOT_FOUND', 'Device does not exist');
        return revoke(signedIn.id, device.token_hash, request.params.deviceId);
    });
    app.post('/v1/employee/logout', async request => {
        const signedIn = await authenticateRequest(host, request);
        const tokenHash = hash(bearer(request));
        const device = (await host.db.pool.query('SELECT id FROM employee_devices WHERE token_hash=$1 AND principal_id=$2', [tokenHash, signedIn.id])).rows[0];
        if (!device) fail('INVALID_INPUT', 'This credential is not an employee device');
        return revoke(signedIn.id, tokenHash, device.id);
    });
}
