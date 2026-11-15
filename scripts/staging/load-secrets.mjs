import { readFile } from 'node:fs/promises';
export async function loadStagingSecrets() {
    const secrets = JSON.parse(await readFile('/run/secrets/company-agent-staging.json', 'utf8'));
    for (const key of ['DATABASE_URL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL']) {
        if (typeof secrets[key] === 'string') process.env[key] = secrets[key];
    }
}
