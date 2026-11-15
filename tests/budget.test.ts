import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { ExecutionBudget } from '../src/budget.js';
test('concurrent reservations cannot oversubscribe a budget and missing usage stays reserved', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/budget-')) });
    try {
        const budget = new ExecutionBudget(host.db);
        const id = randomUUID();
        await budget.open(id, 100);
        const results = await Promise.allSettled([budget.reserve(id, 70), budget.reserve(id, 70)]);
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('BUDGET_EXCEEDED');
        await budget.settle(id, 70, null);
        expect((await budget.get(id)).reserved).toBe(70);
        await budget.settle(id, 70, 50);
        expect(await budget.get(id)).toMatchObject({ reserved: 0, measured: 50 });
        await budget.reserve(id, 50);
        await expect(budget.reserve(id, 1)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    }
    finally {
        await host.close();
    }
});
