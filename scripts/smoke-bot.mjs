import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const origin = 'http://127.0.0.1:' + (process.env.PORT ?? 4317);
const access = JSON.parse(await readFile('.local/access.json', 'utf8'));
async function request(path, method = 'GET', body, actor = 'alice') {
  const response = await fetch(origin + path, { method, headers: { authorization: 'Bearer ' + access[actor], 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.code ?? 'HTTP_FAILED');
  return result;
}
const agentId = 'reference-bot';
const agents = await request('/v1/admin/agents', 'GET', undefined, 'admin');
if (!agents.some(a => a.id === agentId)) {
  await request('/v1/admin/agents', 'POST', { id: agentId, displayName: '框架岗位预设验证', ownerId: 'alice', pluginId: '@example/conformance', pluginVersion: '0.1.0', allowedTools: ['@example/conformance:text.normalize'], servicePermissions: ['memory.self.read', 'memory.self.propose_write', 'report.self.write'], preset: { id: 'company-worker', version: '0.1.0' }, instructions: '这是框架接入验证样例，只使用已授权工具，按要求记录报告。', active: true }, 'admin');
  await request('/v1/agents/' + agentId + '/memory/INDEX', 'PUT', { markdown: '# 私有记忆索引\n这是框架 Bot 验证岗位的独立记忆。按需读取相关笔记。', expectedVersion: 0, sourceRefs: ['fixture:bot-entry'] });
}
const message = { agentId, conversationId: 'local-verification', messageId: randomUUID(), text: '请调用 normalize 工具，整理字符串“  公司   Bot   接通  ”的多余空格；读取自己的 INDEX 笔记，再使用 report_record 记录验证结果。最后只回复整理后的字符串。不要修改笔记。' };
const receipt = await request('/v1/bot/messages', 'POST', message);
const duplicate = await request('/v1/bot/messages', 'POST', message);
if (duplicate.id !== receipt.id) throw new Error('Duplicate message created another task');
const deadline = Date.now() + 180000;
let task;
do {
  task = await request('/v1/tasks/' + receipt.id);
  if (!['queued', 'running'].includes(task.state)) break;
  await new Promise(resolve => setTimeout(resolve, 500));
} while (Date.now() < deadline);
if (task.state !== 'succeeded' || !task.output?.includes('公司 Bot 接通')) throw new Error('Bot task did not succeed: ' + task.state);
const run = await request('/v1/runs/' + task.runId);
const logs = await request('/v1/agents/' + agentId + '/logs');
const usage = await request('/v1/agents/' + agentId + '/usage');
const records = usage.records.filter(r => r.runId === task.runId);
if (run.preset?.id !== 'company-worker' || !logs.some(l => l.type === 'tool.succeeded' && l.data.runId === task.runId) || !logs.some(l => l.type === 'report.recorded' && l.data.runId === task.runId) || !logs.some(l => l.type === 'runtime.tool_succeeded' && l.data.runId === task.runId && l.data.toolName === 'memory_read') || !records.length || records.some(r => r.measurement !== 'provider')) throw new Error('Bot verification evidence is incomplete');
const evidence = { taskId: task.id, runId: task.runId, agentId, state: task.state, preset: run.preset, output: task.output, duplicateDelivery: 'same-task', requests: records.length, inputTokens: records.reduce((n, r) => n + r.inputTokens, 0), outputTokens: records.reduce((n, r) => n + r.outputTokens, 0) };
await writeFile('.local/bot-smoke.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
