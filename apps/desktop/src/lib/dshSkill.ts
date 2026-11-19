import type { H3PromptInput } from "./h3PromptOptimization";

/** Only user selections travel with the card. The VPS loads the skill body. */
export type DshSkill = { id: "text-editor" } | { id: "h3-video-prompt"; parameters: Omit<H3PromptInput, "prompt"> };

export function isDshSkill(value: unknown): value is DshSkill {
  if (!value || typeof value !== "object" || !("id" in value)) return false;
  if (value.id === "text-editor") return Object.keys(value).length === 1;
  if (value.id !== "h3-video-prompt" || Object.keys(value).length !== 2 || !("parameters" in value)) return false;
  const p = value.parameters;
  if (!p || typeof p !== "object" || Object.keys(p).length !== 5 || !("mode" in p) || !("seconds" in p) ||
      !("ratio" in p) || !("firstFrameCount" in p) || !("lastFrameCount" in p)) return false;
  if (typeof p.seconds !== "number" || !(p.seconds > 0 && p.seconds <= 120) ||
      typeof p.ratio !== "string" || !["9:16", "16:9", "4:3", "3:4", "1:1", "auto"].includes(p.ratio)) return false;
  if (p.mode === "text") return p.firstFrameCount === 0 && p.lastFrameCount === 0;
  if (p.mode === "reference") return p.firstFrameCount === 1 && p.lastFrameCount === 0;
  return p.mode === "frames" && p.firstFrameCount === 1 && (p.lastFrameCount === 0 || p.lastFrameCount === 1);
}
