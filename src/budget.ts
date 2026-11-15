import type { Database } from './persistence.js';
import { fail } from './errors.js';
export class ExecutionBudget {
    constructor(private db: Database) { }
    async open(runId: string, limit = 40000) { await this.db.pool.query('INSERT INTO budgets(run_id,token_limit) VALUES($1,$2) ON CONFLICT DO NOTHING', [runId, limit]); }
    async reserve(runId: string, tokens: number) {
        if (!Number.isInteger(tokens) || tokens < 1 || tokens > 40000)
            fail('INVALID_INPUT', 'Invalid token reservation');
        const result = await this.db.pool.query('UPDATE budgets SET reserved=reserved+$2 WHERE run_id=$1 AND token_limit-reserved-measured>=$2 RETURNING run_id', [runId, tokens]);
        if (!result.rowCount)
            fail('BUDGET_EXCEEDED', 'Task token budget is exhausted or awaiting usage reconciliation');
    }
    async settle(runId: string, reserved: number, actual: number | null) {
        if (actual === null)
            return;
        await this.db.pool.query('UPDATE budgets SET reserved=reserved-$2,measured=measured+$3 WHERE run_id=$1', [runId, reserved, actual]);
    }
    async get(runId: string) { return (await this.db.pool.query('SELECT token_limit,reserved,measured FROM budgets WHERE run_id=$1', [runId])).rows[0]; }
}
