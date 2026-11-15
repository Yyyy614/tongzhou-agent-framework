import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
test('editing personal style cannot restore a concurrently revoked tool grant', async () => {
    await mkdir('.test-data', { recursive: true });
    const host = await createFramework({ root: await mkdtemp(resolve('.test-data/preference-race-')) });
    let client: any;
    let change: Promise<unknown> | undefined;
    try {
        await host.installPlugin(resolve('fixtures/conformance-plugin'));
        await host.putActor({ id: 'alice', companyId: 'example', role: 'employee', permissions: [] });
        await host.putAgent({ id: 'worker', ownerId: 'alice', companyId: 'example', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: ['@example/conformance:text.normalize'] });
        client = await host.db.pool.connect();
        await client.query('BEGIN');
        await client.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', ['worker']);
        change = host.personalize({ principalId: 'alice', agentId: 'worker', replyStyle: 'compact' });
        await expect.poll(async () => (await host.db.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND (query LIKE 'INSERT INTO agents%' OR query LIKE 'UPDATE agents SET data%')")).rows[0].n, { interval: 30, timeout: 5000 }).toBeGreaterThan(0);
        await client.query("UPDATE agents SET data=jsonb_set(data,'{allowedTools}','[]'::jsonb) WHERE id='worker'");
        await client.query('COMMIT');
        await change;
        const agent = await host.db.get<any>('agents', 'worker');
        expect(agent.allowedTools).toEqual([]);
        expect(agent.preferences.replyStyle).toBe('compact');
    }
    finally {
        await client?.query('ROLLBACK');
        client?.release();
        await change?.catch(() => { });
        await host.close();
    }
});
