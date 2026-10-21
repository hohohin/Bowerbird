export type ReplicationOperation = "analyze" | "rewrite" | "generate";

export interface ReplicationReference {
  id: string;
  name: string;
  duration: number;
  sourceAssetId?: string | null;
  sourceUrl?: string | null;
  originalUrl?: string | null;
  shareText?: string | null;
}

export interface ReplicationProduct {
  id: string;
  name: string;
  description: string;
}

export interface ReplicationInput {
  operation: ReplicationOperation;
  title: string;
  referenceId?: string;
  sourceAnalysisId?: string;
  sourceRewriteId?: string;
  inputText?: string;
  rewriteDirection?: string;
  frameReference?: ReplicationFrameReference | null;
  persona?: string;
  rules?: string;
  product?: ReplicationProduct | null;
  prompt?: string;
  duration?: number;
  ratio?: string;
  tags?: string[];
  scenes?: string[];
  sellingPoints?: string[];
}

export interface ReplicationTask extends ReplicationInput {
  id: string;
  projectId: string;
  state: "queued" | "analyzing" | "analyzed" | "rewriting" | "rewritten" | "generating" | "completed" | "imported" | "failed" | "interrupted";
  createdAt: string;
  updatedAt: string;
  message: string;
  error: string;
  reference?: ReplicationReference | null;
  analysis: string;
  rewriteOriginalText: string;
  rewrittenText: string;
  firstFramePrompt?: string;
  remoteTaskId?: string | null;
  submissionPending: boolean;
  outputAssetId?: string | null;
  model: string;
  apiBase: string;
  generationJobId?: string;
  generationTurnKey?: string;
  outputPath?: string | null;
  usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } | null;
}

export interface ReplicationFrameReference { assetId: string; time: number; name: string }
export interface ReplicationImageRequest { prompt: string; referenceId?: string; ratio: string }

/** Only extract an explicitly named field/section; never infer an image prompt from a shot. */
export function replicationRewriteParts(text: string): { text: string; firstFramePrompt: string } {
  const keys = ["firstFramePrompt", "first_frame_prompt", "first_frame_image_prompt", "首帧画面提示词", "首帧提示词"];
  try {
    const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (value && !Array.isArray(value) && typeof value === "object") {
      const key = keys.find(key => typeof value[key] === "string");
      if (key) {
        const firstFramePrompt = value[key].trim();
        delete value[key];
        return { text: typeof value.rewrittenText === "string" ? value.rewrittenText : JSON.stringify(value, null, 2), firstFramePrompt };
      }
    }
  } catch { /* Most rewrite responses are Markdown/plain text. */ }
  const heading = /^(?:#{1,6}\s*|\*\*|【)?(?:\d+[.、]\s*)?(?:首帧画面提示词|首帧图片提示词|首帧提示词|first[ _-]?frame[ _-]?(?:image[ _-]?)?prompt)(?:】|\*\*)?\s*[:：]?\s*(?:\*\*)?\s*/im.exec(text);
  if (!heading) return { text, firstFramePrompt: "" };
  const rest = text.slice(heading.index + heading[0].length);
  const next = /\n(?=#{1,6}\s|【[^】\n]+】|\*\*[^*\n]+\*\*\s*[:：]?\s*$)/m.exec(rest);
  const end = next?.index ?? rest.length;
  return {
    text: (text.slice(0, heading.index).trimEnd() + (next ? "\n\n" + rest.slice(end).trimStart() : "")).trim(),
    firstFramePrompt: rest.slice(0, end).trim().replace(/^```(?:text|plaintext)?\s*\n/i, "").replace(/\n```$/, "").trim(),
  };
}

export function replicationRewriteInput(input: Pick<ReplicationInput, "inputText" | "rewriteDirection">): string {
  return input.rewriteDirection?.trim() ? `【参考文本】\n${input.inputText ?? ""}\n\n【改写方向】\n${input.rewriteDirection.trim()}` : input.inputText ?? "";
}

export const REPLICATION_PERSONA = "你是一名短视频广告编导，擅长根据参考视频的节奏和运镜，为新产品设计可执行的分镜。";
export const REPLICATION_RULES = "保留参考内容中适合目标产品的节奏与镜头语言，围绕新产品重写主体、动作和场景。\n按镜头编号输出：时长、画面主体与动作、景别与运镜、光线与色彩、字幕或旁白。\n只使用明确提供的产品信息，不把原视频中的品牌、外观和功效套给新产品；缺失信息标注待确认。";
export const replicationStateLabel: Record<ReplicationTask["state"], string> = {
  queued: "排队中", analyzing: "分析中", analyzed: "分析完成", rewriting: "改写中", rewritten: "改写完成",
  generating: "生成中", completed: "生成完成", imported: "已加入素材库", failed: "未完成", interrupted: "已中断",
};
export const replicationRunning = (task: ReplicationTask) => ["queued", "analyzing", "rewriting", "generating"].includes(task.state);

/** Use the timeline span, not summed shot lengths (shots may overlap). */
export function replicationDuration(text: string): number | null {
  const ranges: Array<[unknown, unknown]> = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const item = value as Record<string, unknown>;
    if ("start" in item || "end" in item) ranges.push([item.start, item.end]);
    else Object.values(item).forEach(visit);
  };
  try { visit(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""))); } catch { /* Plain-text model output. */ }
  const time = "\\d+(?::\\d{1,2}){0,2}(?:\\.\\d+)?";
  if (!ranges.length) {
    let start: string | undefined;
    for (const match of text.matchAll(new RegExp(`["']?\\b(start|end)\\b["']?\\s*[:=：]\\s*["']?(${time})`, "gi"))) {
      if (match[1].toLowerCase() === "start") {
        if (start !== undefined) return null;
        start = match[2];
      } else {
        if (start === undefined) return null;
        ranges.push([start, match[2]]); start = undefined;
      }
    }
    if (start !== undefined) return null;
    if (!ranges.length) for (const match of text.matchAll(new RegExp(`(?:时长|时间段|时间)\\s*[:：]\\s*(${time})\\s*(?:秒|s)?\\s*[-–—~～至]\\s*(${time})\\s*(?:秒|s)?`, "gi"))) ranges.push([match[1], match[2]]);
  }
  const seconds = (value: unknown): number => {
    if (typeof value === "number") return value;
    if (typeof value !== "string" || !/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?(?:\s*(?:s|秒))?$/.test(value.trim())) return NaN;
    const parts = value.trim().replace(/\s*(?:s|秒)$/, "").split(":").map(Number);
    if (parts.slice(1).some(part => part >= 60)) return NaN;
    return parts.reduce((total, part) => total * 60 + part, 0);
  };
  const parsed = ranges.map(([start, end]) => [seconds(start), seconds(end)]);
  if (!parsed.length || parsed.some(([start, end]) => !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start)) return null;
  return Math.ceil(Math.max(...parsed.map(range => range[1])) - Math.min(...parsed.map(range => range[0])));
}

export function validateReplicationInput(input: ReplicationInput): string | null {
  const length = (value: string | undefined, max: number) => !!value?.trim() && [...value].length <= max;
  if (!length(input.title, 100)) return "请填写 1–100 字的标题";
  if (input.operation === "analyze") return input.referenceId ? null : "请先选择参考视频";
  if (input.operation === "rewrite") {
    if (!length(input.inputText, 50000)) return "待改写文本需为 1–50000 字";
    if ([...replicationRewriteInput(input)].length > 50000) return "参考文本与改写方向合计不能超过 50000 字";
    if (!length(input.persona, 8000)) return "人设需为 1–8000 字";
    if (!length(input.rules, 16000)) return "改写规范需为 1–16000 字";
    return null;
  }
  return "请在画板对话框中生成视频";
}
