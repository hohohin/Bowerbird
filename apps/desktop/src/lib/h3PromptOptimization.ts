import type { ComfyVideoMode, ComfyVideoOptions } from "./comfyVideo";

export interface H3PromptInput {
  prompt: string; mode: ComfyVideoMode; seconds: number; ratio: ComfyVideoOptions["ratio"];
  firstFrameCount: number; lastFrameCount: number;
}

/** Send only generation constraints, never local endpoints, paths or asset identifiers. */
export function h3OptimizationInstruction(input: H3PromptInput): string {
  const { prompt: _source, ...parameters } = input;
  return `bowerbird:cloud-text-skill:v1\n${JSON.stringify({ id: "h3-video-prompt", parameters })}`;
}

/** Strip the model's field label, never labels mentioned within dialogue or prose. */
export function cleanH3OptimizedPrompt(text: string): string {
  return text.replace(/^[\t ]*integrated_multimodal_description[\t ]*[:：][\t ]*/gim, "").trim();
}
