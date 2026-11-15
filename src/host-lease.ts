import type { Database } from './persistence.js';
import { fail } from './errors.js';
import type { PoolClient } from 'pg';
export class HostLease {
    private closed = false;
    private constructor(private client: PoolClient, private key: string) { }
    static async acquire(db: Database) {
        const client = await db.pool.connect();
        const key = db.schema + ':exclusive-host';
        try {
            const result = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [key]);
            if (!result.rows[0].acquired)
                fail('HOST_ALREADY_RUNNING', 'Another host owns this framework state');
            return new HostLease(client, key);
        }
        catch (e) {
            client.release();
            throw e;
        }
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            await this.client.query('SELECT pg_advisory_unlock(hashtext($1))', [this.key]);
        }
        finally {
            this.client.release();
        }
    }
}
