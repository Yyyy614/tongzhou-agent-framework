// Independent capability package: mounting it requires no framework source change.
export function apply(ctx){ctx.tools.register('text.format',async input=>({text:(ctx.config.prefix??'')+input.text.trim().replace(/\s+/gu,' ').toUpperCase()}));}
