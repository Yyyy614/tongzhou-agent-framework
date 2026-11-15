// Business behavior belongs to this independent package, never the host.
export function apply(ctx) {
    ctx.tools.register('document.check', async ({ text, requiredTerms }) => {
        const missingTerms = requiredTerms.filter(term => !text.includes(term));
        return { complete: missingTerms.length === 0, missingTerms };
    });
}
