import { loadStagingSecrets } from './load-secrets.mjs';
await loadStagingSecrets();
await import('../../dist/cli.js');
