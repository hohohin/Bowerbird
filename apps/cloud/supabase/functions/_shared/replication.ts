

export const replicationOperations = ["video-analysis", "text-rewrite"] as const;
export function isReplication(operation: unknown): boolean { return replicationOperations.includes(operation as typeof replicationOperations[number]); }
export function replicationService(operation: string): string { return operation === "video-analysis" ? "replication_video_analysis" : "replication_text_rewrite"; }
export function replicationPriceAvailable(row: { active?: unknown; unit_cost?: unknown; parameters?: unknown } | undefined): boolean {
  const parameters = row?.parameters as Record<string, unknown> | null;
  return row?.active === true && parameters?.pricing_ready === true && typeof row.unit_cost === "number" && Number.isFinite(row.unit_cost) && row.unit_cost > 0;
}

export function validateReplication(value: Record<string, unknown>): void {
  const text = (v: unknown, max: number): v is string => typeof v === "string" && !!v.trim() && [...v].length <= max;
  if (value.image != null || value.instruction != null) throw new Error("复刻任务不接受额外图片或隐藏指令");
  if (value.operation === "video-analysis") {
    const video = value.video as Record<string, unknown> | undefined;
    if (!video || video.mime !== "video/mp4" || typeof video.base64 !== "string" || !video.base64 || video.base64.length > Math.ceil(35 * 1024 * 1024 / 3) * 4
      || video.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(video.base64)
      || typeof video.duration !== "number" || !Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 120 || value.rewrite != null) {
      throw new Error("视频分析仅接受不超过 120 秒、35 MiB 的 MP4 代理");
    }
    let prefix: string;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; prefix = ""; let bits = 0, count = 0; for (const char of video.base64.slice(0, 32)) { const digit = alphabet.indexOf(char); if (digit < 0) break; bits = (bits << 6) | digit; count += 6; if (count >= 8) { count -= 8; prefix += String.fromCharCode((bits >>> count) & 255); } }
    if (prefix.slice(4, 8) !== "ftyp") throw new Error("视频内容不是 MP4");
  } else {
    const rewrite = value.rewrite as Record<string, unknown> | undefined;
    if (!rewrite || !text(rewrite.inputText, 50000) || !text(rewrite.persona, 8000) || !text(rewrite.rules, 16000) || value.video != null) throw new Error("请检查待改写文本、人设与规范长度");
    if (rewrite.product != null) {
      const product = rewrite.product as Record<string, unknown>;
      if (!text(product.id, 100) || !text(product.name, 100) || !text(product.description, 8000)
        || Object.keys(product).some(key => !["id", "name", "description"].includes(key))) throw new Error("产品资料只能包含名称与文字说明");
    }
  }
}
