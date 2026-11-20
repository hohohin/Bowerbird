import type { ComfyVideoMode, ComfyVideoOptions } from "./comfyVideo";

export interface H3PromptInput {
  prompt: string; mode: ComfyVideoMode; seconds: number; ratio: ComfyVideoOptions["ratio"];
  firstFrameCount: number; lastFrameCount: number;
  audioReference?: true;
}

export interface H3ImagePromptInput {
  prompt: string; ratio: string; referenceCount: number;
}

const cardToken = /@\[[^\]]+\]/g;
const generationToken = /@\[[^\]]+\]|@(?:图片|图|image)[1-9][0-9]*|<Picture [1-9][0-9]*>/g;

export function imageOptimizationText(prompt: string, composed = false): string {
  const pattern = composed ? generationToken : cardToken;
  const tokens = [...new Set(prompt.match(pattern) ?? [])];
  if (tokens.length && /\{\{REF_\d+\}\}/.test(prompt)) throw new Error("提示词包含与引用标记冲突的文本");
  return prompt.replace(pattern, token => `{{REF_${tokens.indexOf(token) + 1}}}`);
}

export function restoreImageOptimization(prompt: string, result: string, composed = false) {
  const pattern = composed ? generationToken : cardToken;
  const tokens = [...new Set(prompt.match(pattern) ?? [])];
  const original = { text: prompt, keptOriginal: true };
  // Only the local reference map may introduce these references.
  if (result.match(pattern)) return original;
  const markers = /\{\{REF_\d+\}\}/g;
  if (composed && !tokens.length && result.match(markers)) return original;
  if (!tokens.length) return { text: result.trim(), keptOriginal: false };
  const encoded = imageOptimizationText(prompt, composed);
  const known = new Map(tokens.map((token, index) => [`{{REF_${index + 1}}}`, token]));
  if ((result.match(markers) ?? []).some(marker => !known.has(marker))) return original;
  let restored = result.trim();
  if ([...known.keys()].some(marker => restored.split(marker).length !== encoded.split(marker).length)) {
    // Boundary chips have a deterministic position even if the rewriter loses them.
    // Inline chips carry sentence-level meaning and must stay in the original wording.
    const prefix = encoded.match(/^(?:\s*\{\{REF_\d+\}\}\s*)+/)?.[0] ?? "";
    const rest = encoded.slice(prefix.length);
    const suffix = rest.match(/(?:\s*\{\{REF_\d+\}\}\s*)+$/)?.[0] ?? "";
    const middle = rest.slice(0, rest.length - suffix.length);
    if (middle.match(markers)) return original;
    const prose = restored.replace(markers, "").trim();
    if (!prose) return original;
    restored = [prefix.trim(), prose, suffix.trim()].filter(Boolean).join(" ");
  }
  return { text: restored.replace(markers, marker => known.get(marker)!), keptOriginal: false };
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

export function restoreH3VideoAudioReference(original: string, optimized: string): string {
  const tags = /<Audio\s+\d+>/gi;
  const references = optimized.match(tags) ?? [];
  // A connected Ref2VA recording may be cited in multiple sections.
  if (references.some(tag => tag !== "<Audio 1>") || !references.length && original.match(tags)) return original;
  return optimized;
}
