import type { DeepSeekConfig } from "./backend.ts";

/** The model name must match the ACP profile and the metering identity. */
export function dshDeepSeekConfig(env: Record<string, string | undefined>, upstream: DeepSeekConfig): DeepSeekConfig {
  const model = env.BOWERBIRD_DSH_MODEL?.trim() || "deepseek-flash";
  if (model !== "deepseek-flash") throw new Error("BOWERBIRD_DSH_MODEL_mismatch");
  return { ...upstream, model };
}
