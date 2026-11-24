import type { ComfyVideoMode, ComfyVideoOptions } from "./comfyVideo";

export interface H3R2VPromptReferences {
  referenceImageCount: number;
  referenceVideoCount: number;
  referenceAudioCount: number;
}

export interface H3PromptInput extends Partial<H3R2VPromptReferences> {
  prompt: string; mode: ComfyVideoMode; seconds: number; ratio: ComfyVideoOptions["ratio"];
  firstFrameCount: number; lastFrameCount: number;
  audioReference?: true;
}

export function h3R2VPromptReferences(references: import("./comfyVideo").H3VideoReferences): H3R2VPromptReferences {
  return { referenceImageCount: references.referenceImages?.length ?? 0, referenceVideoCount: references.referenceVideos?.length ?? 0,
    referenceAudioCount: references.referenceAudios?.length ?? 0 };
}

/** Keep explicit reference roles and reject tags that cannot exist in the submitted graph. */
export function restoreH3R2VReferences(original: string, optimized: string, counts: Partial<H3R2VPromptReferences>): string {
  const tags = /<(Picture|Video|Audio) (\d+)>/gi;
  const limits = { picture: counts.referenceImageCount ?? 0, video: counts.referenceVideoCount ?? 0,
    audio: (counts.referenceAudioCount ?? 0) + (counts.referenceVideoCount ?? 0) };
  const found = new Set<string>();
  for (const match of optimized.matchAll(tags)) {
    const type = match[1].toLowerCase() as keyof typeof limits;
    const index = Number(match[2]);
    if (index < 1 || index > limits[type]) return original;
    found.add(match[0].toLowerCase());
  }
  return [...original.matchAll(tags)].every(match => found.has(match[0].toLowerCase())) ? optimized : original;
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

/** Legacy body-only results carried the field label; a complete H3 structure keeps both label and sound fields. */
export function cleanH3OptimizedPrompt(text: string): string {
  if (/(?:^|\n)[\t ]*(?:subject_definitions|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music)[\t ]*[:：]/i.test(text)) return text.trim();
  return text.replace(/^[\t ]*integrated_multimodal_description[\t ]*[:：][\t ]*/gim, "").trim();
}

export function restoreH3VideoAudioReference(original: string, optimized: string): string {
  const tags = /<Audio\s+\d+>/gi;
  const references = optimized.match(tags) ?? [];
  // A connected Ref2VA recording may be cited in multiple sections.
  if (references.some(tag => tag !== "<Audio 1>") || !references.length && original.match(tags)) return original;
  return optimized;
}
