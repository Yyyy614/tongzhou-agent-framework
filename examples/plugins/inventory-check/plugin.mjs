export function apply(ctx) {
    ctx.tools.register('inventory.compare', async ({ items }) => {
        const differences = items.filter(item => item.actual !== item.expected).map(item => ({ sku: item.sku, delta: item.actual - item.expected }));
        return { matched: items.length - differences.length, differences };
    });
}
