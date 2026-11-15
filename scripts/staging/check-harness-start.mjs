import { mkdir } from 'node:fs/promises';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
const home = '/app/.local/harness-diagnostic';
await mkdir(home, { recursive: true });
const harness = new DeepSeekHarness({ profile: 'sdk-minimal', dshHome: home, cwd: home, processCwd: home, env: { PATH: process.env.PATH, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, initializeTimeoutMs: 20000 });
try { await harness.start(); console.log('Harness subprocess handshake passed'); }
catch (error) { console.error(String(error).replace(/sk-[A-Za-z0-9_-]+/gu, '[REDACTED]')); process.exitCode = 1; }
finally { await harness.close(); }
