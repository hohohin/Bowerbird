/** UTF-8 bytes conservatively bound text tokens; leave room for system instructions. */
export function shortRewrite(value: { operation?: unknown; rewrite?: unknown }): boolean {
  return value.operation === "text-rewrite" && value.rewrite != null &&
    new TextEncoder().encode(JSON.stringify(value.rewrite)).length <= 8000;
}
export function standardTextFits(instruction: unknown): boolean {
  return instruction == null || (typeof instruction === "string" && new TextEncoder().encode(instruction).length <= 8000);
}
