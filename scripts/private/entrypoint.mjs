import { readFile } from 'node:fs/promises';
const password=(await readFile('/run/secrets/database_password','utf8')).trim();
if(password.length<24)throw Error('Configure a strong database password file before starting');
process.env.DATABASE_URL='postgresql://company_agent:'+encodeURIComponent(password)+'@database:5432/company_agent';
await import('../../dist/cli.js');
