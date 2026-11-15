import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomUUID } from 'node:crypto';
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
const actor = options.get('--actor') ?? 'alice';
const agentId = options.get('--agent') ?? 'reference-bot';
const origin = process.env.COMPANY_AGENT_URL ?? 'http://127.0.0.1:4317';
const tokenFile = options.get('--token-file');
const token = tokenFile ? (await readFile(tokenFile, 'utf8')).trim() : JSON.parse(await readFile('.local/access.json', 'utf8'))[actor];
if (!token) throw new Error('Local employee credential is unavailable');
const conversationId = randomUUID();
async function request(path, body) {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.code ?? 'Request failed');
  return data;
}
async function send(text) {
  // Keep this identity for any delivery retry. Never turn an uncertain send into a new paid task.
  const message = { agentId, conversationId, messageId: randomUUID(), text };
  const task = await request('/v1/bot/messages', message);
  stdout.write(`已受理：${task.id}\n`);
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const current = await request('/v1/tasks/' + task.id);
    if (!['queued', 'running'].includes(current.state)) {
      stdout.write(`${current.state}\n${current.output ?? current.error?.code ?? ''}\n`);
      return current;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`任务仍在执行，请按此编号查询：${task.id}`);
}
if (options.has('--once')) { const result=await send(options.get('--once')); if(result.state!=='succeeded') process.exitCode=1; }
else {
  stdout.write(`公司 Bot · ${actor} → ${agentId}\n本机验证入口；输入 /exit 退出。长期信息存入 Agent 自己的笔记，聊天记录不会整段加载。\n`);
  const input = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const line = await input.question('你：');
      if (line.trim() === '/exit') break;
      if (!line.trim()) continue;
      try { await send(line); } catch (error) { stdout.write(`未完成：${error.message}\n`); }
    }
  } finally { input.close(); }
}
