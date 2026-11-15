/** Generic host-only capabilities. Business-specific data stays behind subjectRef. */
export function apply(ctx) {
    ctx.tools.register('team.list', async (_, { services }) => services.team.list());
    ctx.tools.register('work.dispatch', async (input, { services }) => services.work.dispatch(input));
    ctx.tools.register('work.list', async (_, { services }) => services.work.list());
    ctx.tools.register('work.read', async ({ id }, { services }) => services.work.read(id));
    ctx.tools.register('reminder.schedule', async (input, { services }) => services.reminders.schedule(input));
    ctx.tools.register('reminder.list', async (_, { services }) => services.reminders.list());
    ctx.tools.register('inbox.list', async (_, { services }) => services.inbox.list());
    ctx.tools.register('event.publish', async (input, { services }) => services.events.publish(input));
}
