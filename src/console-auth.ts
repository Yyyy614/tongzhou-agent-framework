import type { Framework } from './index.js';
import { fail } from './errors.js';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor } from './types.js';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function consoleCookie(request: Pick<FastifyRequest, 'headers'>) { return /(?:^|;\s*)fw_console=([A-Za-z0-9_-]+)/u.exec(request.headers.cookie ?? '')?.[1]; }
export function assertSameOrigin(request: FastifyRequest) {
    const origin = request.headers.origin;
    let expected: string;
    try {
        expected = new URL(`${request.protocol}://${request.headers.host}`).origin;
    }
    catch {
        fail('PERMISSION_DENIED', 'Console request origin is not allowed');
    }
    if (!origin || origin !== expected)
        fail('PERMISSION_DENIED', 'Console request origin is not allowed');
}
export class ConsoleSessions {
    constructor(private host: Framework) { }
    async issueCode(principalId: string) { const actor = await this.host.db.get<Actor>('actors', principalId); if (!actor.active)
        fail('UNAUTHENTICATED', 'Actor is inactive'); const code = 'fw_entry_' + randomBytes(24).toString('base64url'); await this.host.db.pool.query("INSERT INTO console_entries(hash,principal_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')", [digest(code), actor.id]); return code; }
    async login(input: {
        code?: string;
        accessToken?: string;
    }) {
        let actor: Actor;
        if (input.code) {
            const row = (await this.host.db.pool.query('DELETE FROM console_entries WHERE hash=$1 AND expires_at>now() RETURNING principal_id', [digest(input.code)])).rows[0];
            if (!row)
                fail('UNAUTHENTICATED', 'Entry code is invalid or expired');
            actor = await this.host.db.get<Actor>('actors', row.principal_id);
        }
        else
            actor = await this.host.authenticate(input.accessToken ?? '');
        if (!actor.active)
            fail('UNAUTHENTICATED', 'Actor is inactive');
        const token = 'fw_console_' + randomBytes(32).toString('base64url');
        await this.host.db.pool.query("INSERT INTO console_sessions(hash,principal_id,expires_at,credential_hash) VALUES($1,$2,now()+interval '8 hours',$3)", [digest(token), actor.id, input.accessToken ? digest(input.accessToken) : null]);
        await this.host.db.audit('console.login', { principalId: actor.id, companyId: actor.companyId });
        return token;
    }
    async authenticate(token: string) { if (token.length > 160)
        fail('UNAUTHENTICATED', 'Invalid console session'); const row = (await this.host.db.pool.query('SELECT principal_id FROM console_sessions s WHERE hash=$1 AND expires_at>now() AND (credential_hash IS NULL OR EXISTS(SELECT 1 FROM access_tokens a WHERE a.hash=s.credential_hash AND a.principal_id=s.principal_id AND a.expires_at>now()))', [digest(token)])).rows[0]; if (!row)
        fail('UNAUTHENTICATED', 'Console session has expired'); const actor = await this.host.db.get<Actor>('actors', row.principal_id); if (!actor.active)
        fail('UNAUTHENTICATED', 'Actor is inactive'); return actor; }
    async logout(token: string) { await this.host.db.pool.query('DELETE FROM console_sessions WHERE hash=$1', [digest(token)]); }
}
export async function authenticateRequest(host: Framework, request: FastifyRequest) { const authorization = request.headers.authorization; if (authorization?.startsWith('Bearer '))
    return host.authenticate(authorization.slice(7)); const token = consoleCookie(request); if (!token)
    fail('UNAUTHENTICATED', 'Sign in to the console'); return new ConsoleSessions(host).authenticate(token); }
export function registerConsoleAuth(app: FastifyInstance, host: Framework) {
    const sessions = new ConsoleSessions(host);
    app.addHook('onRequest', async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store');
        if (consoleCookie(request) && !request.headers.authorization?.startsWith('Bearer ') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
            assertSameOrigin(request);
    });
    app.get('/console/me', async (request) => { const actor = await authenticateRequest(host, request); return { id: actor.id, companyId: actor.companyId, role: actor.role, displayName: actor.displayName ?? actor.id }; });
    app.post<{
        Body: {
            code?: string;
            accessToken?: string;
        };
    }>('/console/login', { schema: { body: { type: 'object', additionalProperties: false, oneOf: [{ required: ['code'] }, { required: ['accessToken'] }], properties: { code: { type: 'string', maxLength: 160 }, accessToken: { type: 'string', maxLength: 256 } } } } }, async (request, reply) => { assertSameOrigin(request); const token = await sessions.login(request.body); return reply.header('Set-Cookie', `fw_console=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${request.protocol === 'https' ? '; Secure' : ''}`).send({ ok: true }); });
    app.post('/console/logout', async (request, reply) => { assertSameOrigin(request); await sessions.logout(consoleCookie(request) ?? ''); return reply.header('Set-Cookie', 'fw_console=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0').send({ ok: true }); });
}
