// SDK-minimal has no preset selection UI. Bind its one admitted company task
// through the same native registry that Harness desktop/web use.
export const inject = ['agents', 'agentPresets'];
export function apply(ctx, config) {
  if (!config?.presetId) throw new Error('A managed preset is required');
  ctx.on('agent/created', async ({ agent }) => {
    const preset = await ctx.agentPresets.mount(agent.ctx, config.presetId);
    agent.session.append('agent-preset/selected', { agentPreset: preset.id });
  });
}
