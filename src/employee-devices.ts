import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Framework } from './index.js';
import type { Actor, Agent } from './types.js';
import { fail } from './errors.js';
export const credentialHash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function readyEmployeeAgents(host: Framework, employee: Actor, transaction?: PoolClient) {
    const agents = (await (transaction ?? host.db.pool).query('SELECT data FROM agents WHERE data->>\'ownerId\'=$1 AND data->>\'companyId\'=$2', [employee.id, employee.companyId])).rows.map(row => row.data as Agent).filter(a => a.active && a.runtime !== 'remote');
    return agents.filter(a => a.preset && host.bindings(a).every(b => host.registry.list().some(p => p.enabled && p.id === b.pluginId && p.version === b.pluginVersion)));
}
export class EmployeeDevices {
    constructor(private host: Framework) {}
    private async issue(client: PoolClient, employee: Actor, deviceName: string) {
        if (!(await readyEmployeeAgents(this.host, employee, client)).length) fail('PERMISSION_DENIED', 'No assigned Harness Agent is available');
        const count = (await client.query('SELECT count(*)::int AS n FROM employee_devices WHERE principal_id=$1 AND revoked_at IS NULL AND expires_at>now()', [employee.id])).rows[0].n;
        if (count >= 5) fail('BUDGET_EXCEEDED', 'Ask the administrator to revoke an old device first');
        const accessToken = 'fw_auth_' + randomBytes(32).toString('base64url'), deviceId = randomUUID();
        const expiresAt = (await client.query("INSERT INTO access_tokens(hash,principal_id,expires_at) VALUES($1,$2,now()+interval '30 days') RETURNING expires_at", [credentialHash(accessToken), employee.id])).rows[0].expires_at;
        await client.query('INSERT INTO employee_devices(id,principal_id,token_hash,name,expires_at) VALUES($1,$2,$3,$4,$5)', [deviceId, employee.id, credentialHash(accessToken), deviceName.trim(), expiresAt]);
        await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'employee.device_activated', JSON.stringify({ principalId: employee.id, companyId: employee.companyId, deviceId })]);
        return { accessToken, deviceId, expiresAt, employee: { id: employee.id, displayName: employee.displayName ?? employee.id, companyId: employee.companyId } };
    }
    private async locked<T>(principalId: string, action: (client: PoolClient, employee: Actor) => Promise<T>) {
        const client = await this.host.db.pool.connect();
        try {
            await client.query('BEGIN');
            const employee = (await client.query('SELECT data FROM actors WHERE id=$1 FOR UPDATE', [principalId])).rows[0]?.data as Actor | undefined;
            if (!employee?.active || employee.role !== 'employee') fail('UNAUTHENTICATED', 'Employee account is unavailable');
            const result = await action(client, employee);
            await client.query('COMMIT');
            return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    async activate(input: { code: string; deviceName: string }, passwordHash?: string) {
        const codeHash = credentialHash(input.code);
        const hint = (await this.host.db.pool.query('SELECT principal_id FROM employee_invitations WHERE hash=$1 AND expires_at>now()', [codeHash])).rows[0];
        if (!hint) fail('UNAUTHENTICATED', 'Activation code is invalid, used or expired');
        return this.locked(hint.principal_id, async (client, employee) => {
            const consumed = await client.query('DELETE FROM employee_invitations WHERE hash=$1 AND expires_at>now() RETURNING id', [codeHash]);
            if (!consumed.rowCount) fail('UNAUTHENTICATED', 'Activation code is invalid, used or expired');
            if (passwordHash) {
                await client.query('INSERT INTO employee_credentials(principal_id,password_hash) VALUES($1,$2) ON CONFLICT(principal_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,updated_at=now()', [employee.id, passwordHash]);
                await client.query('DELETE FROM access_tokens WHERE principal_id=$1', [employee.id]);
                await client.query('DELETE FROM console_sessions WHERE principal_id=$1', [employee.id]);
                await client.query('UPDATE employee_devices SET revoked_at=COALESCE(revoked_at,now()) WHERE principal_id=$1', [employee.id]);
                await client.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [randomUUID(), 'employee.password_set', JSON.stringify({ principalId: employee.id, companyId: employee.companyId })]);
            }
            return this.issue(client, employee, input.deviceName);
        });
    }
    async login(principalId: string, expectedHash: string, deviceName: string) {
        return this.locked(principalId, async (client, employee) => {
            const current = (await client.query('SELECT password_hash FROM employee_credentials WHERE principal_id=$1', [employee.id])).rows[0];
            if (!current || current.password_hash !== expectedHash) fail('UNAUTHENTICATED', 'Account or password is incorrect');
            return this.issue(client, employee, deviceName);
        });
    }
}
