import skill from "../skills/h3-video-prompt/SKILL.md?raw";
import type { ComfyVideoMode, ComfyVideoOptions } from "./comfyVideo";

export interface H3PromptInput {
  prompt: string; mode: ComfyVideoMode; seconds: number; ratio: ComfyVideoOptions["ratio"];
  firstFrameCount: number; lastFrameCount: number;
}

/** Send only generation constraints, never local endpoints, paths or asset identifiers. */
export function h3OptimizationInstruction(input: H3PromptInput): string {
  const { prompt: _source, ...parameters } = input;
  return `${skill}\n\n本次生成参数：${JSON.stringify(parameters)}`;
}
