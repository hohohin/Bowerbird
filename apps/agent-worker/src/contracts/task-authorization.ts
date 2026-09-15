/** Goal-scoped authorization. Counts are ceilings, never an execution sequence. */
export const TASK_CAPABILITIES = [
  "generate_image", "inspect_artifact", "compose_html", "render_html",
] as const;
export type TaskCapability = typeof TASK_CAPABILITIES[number];
export type TaskAuthorization = {
  schemaVersion: 3;
  title: string;
  summary: string;
  assetIds: string[];
  outputCount: number;
  modelTurns: number;
  capabilities: Array<{ tool: TaskCapability; maxCalls: number }>;
};

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.sort().join(",")) throw new Error("task_authorization_invalid");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error("task_authorization_invalid");
  return value.trim();
}
function integer(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error("task_authorization_invalid");
  return Number(value);
}
export function parseTaskAuthorization(value: unknown): TaskAuthorization {
  const raw = record(value, ["schemaVersion", "title", "summary", "assetIds", "outputCount", "modelTurns", "capabilities"]);
  if (raw.schemaVersion !== 3 || !Array.isArray(raw.assetIds) || raw.assetIds.length > 64 ||
      !Array.isArray(raw.capabilities) || !raw.capabilities.length || raw.capabilities.length > TASK_CAPABILITIES.length) {
    throw new Error("task_authorization_invalid");
  }
  const assetIds = raw.assetIds.map((id) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error("task_authorization_invalid");
    return id;
  });
  const capabilities = raw.capabilities.map((value) => {
    const item = record(value, ["tool", "maxCalls"]);
    if (!TASK_CAPABILITIES.includes(item.tool as TaskCapability)) throw new Error("task_authorization_invalid");
    return { tool: item.tool as TaskCapability, maxCalls: integer(item.maxCalls, 31) };
  });
  if (new Set(assetIds).size !== assetIds.length || new Set(capabilities.map((item) => item.tool)).size !== capabilities.length ||
      capabilities.reduce((sum, item) => sum + item.maxCalls, 1) > 32) throw new Error("task_authorization_invalid");
  return { schemaVersion: 3, title: text(raw.title, 120), summary: text(raw.summary, 2000), assetIds,
    outputCount: integer(raw.outputCount, 31), modelTurns: integer(raw.modelTurns, 128), capabilities };
}

export function taskAuthorizationCallCount(authorization: TaskAuthorization): number {
  return authorization.capabilities.reduce((sum, item) => sum + item.maxCalls, 1);
}
