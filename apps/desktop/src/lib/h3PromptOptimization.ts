import type { ComfyVideoMode, ComfyVideoOptions } from "./comfyVideo";

export interface H3PromptInput {
  prompt: string; mode: ComfyVideoMode; seconds: number; ratio: ComfyVideoOptions["ratio"];
  firstFrameCount: number; lastFrameCount: number;
}

export interface H3ImagePromptInput {
  prompt: string; ratio: string; referenceCount: number;
}

export function imageOptimizationText(prompt: string, result?: string): string {
  const tokens = [...new Set(prompt.match(/@\[[^\]]+\]/g) ?? [])];
  if (!tokens.length) return result?.trim() ?? prompt;
  if (/\{\{REF_\d+\}\}/.test(prompt)) throw new Error("提示词包含与引用标记冲突的文本");
  if (result === undefined) return prompt.replace(/@\[[^\]]+\]/g, token => `{{REF_${tokens.indexOf(token) + 1}}}`);
  for (const [index, token] of tokens.entries()) {
    if (result.split(`{{REF_${index + 1}}}`).length !== prompt.split(token).length)
      throw new Error("优化结果缺少或重复了卡片引用，请保留原提示词后重试");
  }
  return result.trim().replace(/\{\{REF_(\d+)\}\}/g, (_, n) => {
    if (!tokens[Number(n) - 1]) throw new Error("优化结果包含未知的卡片引用");
    return tokens[Number(n) - 1];
  });
}

/** Send only generation constraints, never local endpoints, paths or asset identifiers. */
export function h3OptimizationInstruction(input: H3PromptInput | H3ImagePromptInput): string {
  const { prompt: _source, ...parameters } = input;
  return `bowerbird:cloud-text-skill:v1\n${JSON.stringify({ id: "referenceCount" in input ? "h3-image-prompt" : "h3-video-prompt", parameters })}`;
}

/** Strip the model's field label, never labels mentioned within dialogue or prose. */
export function cleanH3OptimizedPrompt(text: string): string {
  return text.replace(/^[\t ]*integrated_multimodal_description[\t ]*[:：][\t ]*/gim, "").trim();
}
