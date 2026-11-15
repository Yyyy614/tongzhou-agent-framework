import { Pool, type PoolConfig, type PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fail } from './errors.js';
export function redact(value: unknown): any {
    if (typeof value === 'string')
        return value.replace(/sk-[A-Za-z0-9_-]{12,}/gu, '[REDACTED]').replace(/fw_(?:run|auth|console|entry|client|invite)_[A-Za-z0-9_.-]+/gu, '[REDACTED]');
    if (Array.isArray(value))
        return value.map(redact);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(?:api[_-]?key|authorization|password|secret|token|access_token)$/iu.test(k) ? '[REDACTED]' : redact(v)]));
    return value;
}
export class Database {
    readonly schema: string;
    pool!: Pool;
    constructor(private root: string, private config?: PoolConfig) { this.schema = 'fw_' + createHash('sha256').update(resolve(root)).digest('hex').slice(0, 14); }
    async open() {
        const config = this.config ?? (process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : JSON.parse(await readFile(resolve('.local/database.json'), 'utf8')));
        this.pool = new Pool({ ...config, max: 8, connectionTimeoutMillis: 5000, options: `-c search_path=${this.schema},public` });
        await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
        await this.pool.query(`
 CREATE TABLE IF NOT EXISTS actors(id text PRIMARY KEY,data jsonb NOT NULL);
 CREATE TABLE IF NOT EXISTS provider_channels(company_id text NOT NULL,id text NOT NULL,data jsonb NOT NULL,credential text,cooldown_until timestamptz,last_status integer,last_used timestamptz,PRIMARY KEY(company_id,id));
 CREATE TABLE IF NOT EXISTS channel_leases(id uuid PRIMARY KEY,company_id text NOT NULL,channel_id text NOT NULL,account_group text NOT NULL,principal_id text NOT NULL,expires_at timestamptz NOT NULL);
 CREATE TABLE IF NOT EXISTS departments(id text PRIMARY KEY,data jsonb NOT NULL);
 CREATE TABLE IF NOT EXISTS console_entries(hash text PRIMARY KEY,principal_id text NOT NULL,expires_at timestamptz NOT NULL);
 CREATE TABLE IF NOT EXISTS console_sessions(hash text PRIMARY KEY,principal_id text NOT NULL,expires_at timestamptz NOT NULL);
 ALTER TABLE console_sessions ADD COLUMN IF NOT EXISTS credential_hash text;
 CREATE TABLE IF NOT EXISTS access_tokens(hash text PRIMARY KEY,principal_id text NOT NULL,expires_at timestamptz NOT NULL);
 CREATE TABLE IF NOT EXISTS employee_invitations(id uuid PRIMARY KEY,hash text NOT NULL UNIQUE,principal_id text NOT NULL,created_by text NOT NULL,expires_at timestamptz NOT NULL);
 CREATE TABLE IF NOT EXISTS employee_devices(id uuid PRIMARY KEY,principal_id text NOT NULL,token_hash text NOT NULL UNIQUE,name text NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS employee_credentials(principal_id text PRIMARY KEY,password_hash text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS employee_login_limits(key text PRIMARY KEY,attempts integer NOT NULL,window_start timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS agents(id text PRIMARY KEY,data jsonb NOT NULL);
 CREATE TABLE IF NOT EXISTS audit(seq bigserial PRIMARY KEY,id uuid NOT NULL UNIQUE,type text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS invocations(key text PRIMARY KEY,input_hash text NOT NULL,state text NOT NULL,receipt jsonb,updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS memories(agent_id text NOT NULL,note_id text NOT NULL,version integer NOT NULL,markdown text NOT NULL,source_refs jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(agent_id,note_id));
 CREATE TABLE IF NOT EXISTS runs(id uuid PRIMARY KEY,agent_id text NOT NULL,principal_id text NOT NULL,state text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE runs ADD COLUMN IF NOT EXISTS request_key text;
 CREATE UNIQUE INDEX IF NOT EXISTS runs_request_key ON runs(request_key);
 CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_agent ON runs(agent_id) WHERE state='running';
 CREATE TABLE IF NOT EXISTS usage(id uuid PRIMARY KEY,run_id uuid NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS budgets(run_id uuid PRIMARY KEY,token_limit integer NOT NULL,reserved integer NOT NULL DEFAULT 0,measured integer NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS approvals(id uuid PRIMARY KEY,principal_id text NOT NULL,agent_id text NOT NULL,tool_ref text NOT NULL,plugin_version text NOT NULL,input_hash text NOT NULL,approved_by text NOT NULL,expires_at timestamptz NOT NULL,used_at timestamptz);
 CREATE TABLE IF NOT EXISTS tasks(id uuid PRIMARY KEY,agent_id text NOT NULL,principal_id text NOT NULL,state text NOT NULL,request_key text NOT NULL UNIQUE,input_hash text NOT NULL,data jsonb NOT NULL,job_id uuid,parent_id uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS bot_messages(key text PRIMARY KEY,input_hash text NOT NULL,principal_id text NOT NULL,agent_id text NOT NULL,task_id uuid REFERENCES tasks(id),created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS work_items(id uuid PRIMARY KEY,company_id text NOT NULL,created_by text NOT NULL,request_key text NOT NULL UNIQUE,input_hash text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS work_assignments(work_id uuid NOT NULL REFERENCES work_items(id),task_id uuid NOT NULL UNIQUE REFERENCES tasks(id),agent_id text NOT NULL,owner_id text NOT NULL,PRIMARY KEY(work_id,agent_id));
 CREATE TABLE IF NOT EXISTS work_reviews(work_id uuid PRIMARY KEY REFERENCES work_items(id),revision text NOT NULL,reviewed_by text NOT NULL,decision text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS assistant_reminders(id uuid PRIMARY KEY,company_id text NOT NULL,principal_id text NOT NULL,created_by text NOT NULL,agent_id text NOT NULL,due_at timestamptz NOT NULL,state text NOT NULL,request_key text NOT NULL UNIQUE,input_hash text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS assistant_inbox(id uuid PRIMARY KEY,company_id text NOT NULL,principal_id text NOT NULL,key text NOT NULL UNIQUE,kind text NOT NULL,data jsonb NOT NULL,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS assistant_events(id uuid PRIMARY KEY,company_id text NOT NULL,created_by text NOT NULL,agent_id text NOT NULL,source text NOT NULL,type text NOT NULL,state text NOT NULL,request_key text NOT NULL UNIQUE,input_hash text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS assistant_rules(id text PRIMARY KEY,company_id text NOT NULL,created_by text NOT NULL,data jsonb NOT NULL);
 ALTER TABLE work_items ADD COLUMN IF NOT EXISTS observed_at timestamptz;
 ALTER TABLE work_items ADD COLUMN IF NOT EXISTS observed_state text;
 ALTER TABLE work_items ADD COLUMN IF NOT EXISTS current_round integer NOT NULL DEFAULT 1;
 ALTER TABLE work_items ADD COLUMN IF NOT EXISTS control_revision integer NOT NULL DEFAULT 0;
 ALTER TABLE work_items ADD COLUMN IF NOT EXISTS control_mode text NOT NULL DEFAULT 'active';
 ALTER TABLE work_items ADD COLUMN IF NOT EXISTS control_data jsonb NOT NULL DEFAULT '{}';
 ALTER TABLE work_items ADD COLUMN IF NOT EXISTS action_scope integer NOT NULL DEFAULT 1;
 CREATE TABLE IF NOT EXISTS work_controls(id uuid PRIMARY KEY,work_id uuid NOT NULL REFERENCES work_items(id),principal_id text NOT NULL,request_key text NOT NULL UNIQUE,input_hash text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS work_actions(id uuid PRIMARY KEY,work_id uuid NOT NULL REFERENCES work_items(id),action_scope integer NOT NULL,agent_id text NOT NULL,task_id uuid NOT NULL REFERENCES tasks(id),run_id uuid,action_key text NOT NULL UNIQUE,state text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS work_reconciliations(id uuid PRIMARY KEY,work_id uuid NOT NULL REFERENCES work_items(id),task_id uuid,action_id uuid,reviewed_by text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS work_action_attempts(id uuid PRIMARY KEY,action_id uuid NOT NULL REFERENCES work_actions(id),task_id uuid NOT NULL REFERENCES tasks(id),run_id uuid,state text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS work_inputs(id uuid PRIMARY KEY,work_id uuid NOT NULL REFERENCES work_items(id),round integer NOT NULL,principal_id text NOT NULL,request_key text NOT NULL UNIQUE,input_hash text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS work_round_assignments(work_id uuid NOT NULL REFERENCES work_items(id),round integer NOT NULL,task_id uuid NOT NULL UNIQUE REFERENCES tasks(id),agent_id text NOT NULL,owner_id text NOT NULL,PRIMARY KEY(work_id,round,agent_id));
 CREATE TABLE IF NOT EXISTS work_checkpoints(id uuid PRIMARY KEY,work_id uuid NOT NULL REFERENCES work_items(id),round integer NOT NULL,revision text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(work_id,round));
 CREATE TABLE IF NOT EXISTS work_review_history(work_id uuid NOT NULL REFERENCES work_items(id),round integer NOT NULL,revision text NOT NULL,reviewed_by text NOT NULL,decision text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(work_id,revision));
 `);
    }
    async put(kind: 'actors' | 'agents', id: string, value: unknown) { await this.pool.query(`INSERT INTO ${kind}(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`, [id, JSON.stringify(value)]); }
    async get<T>(kind: 'actors' | 'agents', id: string, client: Pick<PoolClient, 'query'> = this.pool): Promise<T> {
        const { rows } = await client.query(`SELECT data FROM ${kind} WHERE id=$1`, [id]);
        if (!rows[0])
            fail('NOT_FOUND', kind + ' record does not exist');
        return rows[0].data;
    }
    async list<T>(kind: 'actors' | 'agents'): Promise<T[]> { return (await this.pool.query(`SELECT data FROM ${kind} ORDER BY id`)).rows.map(r => r.data); }
    async audit(type: string, data: unknown) { const id = randomUUID(); await this.pool.query('INSERT INTO audit(id,type,data) VALUES($1,$2,$3)', [id, type, JSON.stringify(redact(data))]); return id; }
    async close() { await this.pool?.end(); }
}
