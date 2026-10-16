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

export const REPLICATION_PERSONA = "你是一名短视频广告编导，擅长根据参考视频的节奏和运镜，为新产品设计可执行的分镜。";
export const REPLICATION_RULES = "保留参考内容中适合目标产品的节奏与镜头语言，围绕新产品重写主体、动作和场景。\n按镜头编号输出：时长、画面主体与动作、景别与运镜、光线与色彩、字幕或旁白。\n只使用明确提供的产品信息，不把原视频中的品牌、外观和功效套给新产品；缺失信息标注待确认。";
export const REPLICATION_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
export const replicationStateLabel: Record<ReplicationTask["state"], string> = {
  queued: "排队中", analyzing: "分析中", analyzed: "分析完成", rewriting: "改写中", rewritten: "改写完成",
  generating: "生成中", completed: "生成完成", imported: "已加入素材库", failed: "未完成", interrupted: "已中断",
};
export const replicationRunning = (task: ReplicationTask) => ["queued", "analyzing", "rewriting", "generating"].includes(task.state);

export function validateReplicationInput(input: ReplicationInput): string | null {
  const length = (value: string | undefined, max: number) => !!value?.trim() && [...value].length <= max;
  if (!length(input.title, 100)) return "请填写 1–100 字的标题";
  if (input.operation === "analyze") return input.referenceId ? null : "请先选择参考视频";
  if (input.operation === "rewrite") {
    if (!length(input.inputText, 50000)) return "待改写文本需为 1–50000 字";
    if (!length(input.persona, 8000)) return "人设需为 1–8000 字";
    if (!length(input.rules, 16000)) return "改写规范需为 1–16000 字";
    return null;
  }
  if (!input.product?.name.trim()) return "请先选择目标产品";
  if (!length(input.prompt, 12000)) return "生成提示词需为 1–12000 字，请精简后再提交";
  if (!Number.isInteger(input.duration) || input.duration! < 4 || input.duration! > 12) return "视频时长需为 4–12 秒的整数";
  if (!REPLICATION_RATIOS.includes(input.ratio ?? "")) return "请选择视频画幅";
  return null;
}
