// Contract fixture only. The framework SDK and plugin-worker are not implemented here.
export const name = "@example/conformance";
export function apply(ctx) {
  ctx.tools.register("text.normalize", async (input) => ({
    text: input.text.trim().replace(/\s+/gu, " "),
  }));
}

