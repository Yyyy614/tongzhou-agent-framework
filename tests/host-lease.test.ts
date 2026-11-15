import { test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../src/index.js';
import { HostLease } from '../src/host-lease.js';
test('a second host cannot acquire ownership or recover the first host live work', async () => {
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/lease-'));
    const first = await createFramework({ root });
    const second = await createFramework({ root });
    let lease: HostLease | undefined;
    try {
        lease = await HostLease.acquire(first.db);
        await expect(HostLease.acquire(second.db)).rejects.toMatchObject({ code: 'HOST_ALREADY_RUNNING' });
        await lease.close();
        lease = await HostLease.acquire(second.db);
    }
    finally {
        await lease?.close();
        await first.close();
        await second.close();
    }
});
