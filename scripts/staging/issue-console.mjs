import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFramework } from '../../dist/index.js';
import { ConsoleSessions } from '../../dist/console-auth.js';
import { loadStagingSecrets } from './load-secrets.mjs';
await loadStagingSecrets();
const host = await createFramework({ root: resolve('.local/host') });
try {
    const code = await new ConsoleSessions(host).issueCode('admin');
    await writeFile('.local/console-entry.json', JSON.stringify({ url: process.env.PUBLIC_ORIGIN + '/#entry=' + code, expiresAt: new Date(Date.now() + 600000).toISOString() }), { mode: 0o600 });
    console.log('Staging console entry saved to private state; no credentials printed.');
} finally { await host.close(); }
