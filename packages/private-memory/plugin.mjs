const note = ({noteId,version,markdown}) => ({noteId,version,markdown});
export function apply(ctx) {
    ctx.tools.register('notes.read', async (input,{services}) => note(await services.memory.read(input)));
    ctx.tools.register('notes.write', async (input,{services}) => note(await services.memory.proposeWrite(input)));
    ctx.tools.register('report.record', async (input,{services}) => services.reports.record(input));
}
