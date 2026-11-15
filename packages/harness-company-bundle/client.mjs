import { AsyncLocalStorage } from 'node:async_hooks';
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';

// Native services can be scoped to an Agent. Register its tools at creation;
// root lifecycle/stream listeners need no globally injected runtime services.

/** Native Host plugin; no credentials or filesystem bridge enter the renderer. */
export async function apply(ctx, config) {
  const turns = new Map();
  const wire = new AsyncLocalStorage();
  const lifetime = new AbortController();
  const base = config.mcpURL.replace(/\/mcp$/u, '');
  const modelEndpoint = config.modelURL.replace(/\/$/u, '') + '/v1/messages';
  const originalFetch = globalThis.fetch;
  const wrappedFetch = (input, init) => {
    const address = input instanceof Request ? input.url : String(input);
    const identity = wire.getStore();
    if (address !== modelEndpoint || !identity) return originalFetch(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('x-company-turn-id', identity.turnId);
    headers.set('x-deepseek-harness-session-id', identity.sessionId);
    return originalFetch(input, { ...init, headers });
  };
  globalThis.fetch = wrappedFetch;
  ctx.effect(() => () => {
    lifetime.abort();
    if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
    wire.disable();
  });
  async function request(path, body, identity, signal) {
    const headers = { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' };
    if (identity) { headers['x-deepseek-harness-session-id'] = identity.sessionId; headers['x-company-turn-id'] = identity.turnId; }
    const response = await originalFetch(base + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.any([lifetime.signal, signal ?? AbortSignal.timeout(30000)]) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? 'Company request could not be confirmed');
    return result;
  }
  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id);
    if (event.type === 'turn/start') {
      const prior = turns.get(sessionId);
      const state = { sessionId, turnId: String(event.seq), ready: undefined, cleanup: undefined };
      state.ready = Promise.resolve(prior?.cleanup).catch(() => {}).then(() => request('/turn/start', { sessionId, turnId: state.turnId }));
      // Errors are observed by llm/stream before any provider request starts.
      state.ready.catch(() => {});
      turns.set(sessionId, state);
    }
    if (event.type === 'turn/end') {
      const state = turns.get(sessionId);
      if (!state) return;
      const reason = event.data?.reason?.kind ?? 'end';
      state.cleanup = state.ready.then(() => request(reason === 'aborted' || reason === 'error' ? '/turn/cancel' : '/turn/end', { sessionId, turnId: state.turnId, reason }));
      state.cleanup.catch(() => { ctx.logger.warn('Company completion could not be confirmed; inspect the task state.'); });
    }
  });
  ctx.on('llm/stream', (options, next) => (async function* () {
    const state = turns.get(String(options.sessionId ?? ''));
    if (!state) throw new Error('A company native turn is required');
    await state.ready;
    // Loop requests are frozen by Harness. Carry transport metadata through
    // async context instead of rewriting the model's request or session log.
    const iterator = next()[Symbol.asyncIterator]();
    try {
      while (true) {
        const frame = await wire.run(state, () => iterator.next());
        if (frame.done) break;
        yield frame.value;
      }
    } finally { await iterator.return?.(); }
  })());
  const description = request('/mcp', { jsonrpc: '2.0', id: 'describe', method: 'tools/list' });
  ctx.on('agent/created', async ({ agent }) => {
  const described = await description;
  for (const tool of described.result.tools) {
    const definition = createMcpToolDefinition(agent.ctx, {
      name: 'mcp__company__' + tool.name, rawName: tool.name,
      description: tool.description, inputSchema: tool.inputSchema,
      async call(args, execution) {
        const state = turns.get(String(execution.agent?.session.id ?? ''));
        if (!state) throw new Error('Company tool has no native session identity');
        await state.ready;
        const result = await request('/mcp', { jsonrpc: '2.0', id: String(execution.callId), method: 'tools/call', params: { name: tool.name, arguments: args } }, state, execution.signal);
        if (!result.result) throw new Error('Company tool returned no receipt');
        return result.result;
      },
    });
    agent.ctx.effect(() => agent.ctx.tools.register(definition));
  }
  });
  await description;
}
