import type { CreditTransaction } from "./types";

const SERVICES: Record<string, string> = {
  image_hd: "图片生成 · 高清", image_fast: "图片生成 · 快速", image_lite: "图片生成 · 轻量", image_sd: "图片生成 · 标准",
  classification: "素材自动分类", understand: "图片理解", reverse: "图片反推", rename: "素材命名",
  video_replication_analyze: "参考视频分析", video_replication_rewrite: "视频文案改写",
  replication_video_analysis: "参考视频分析", replication_text_rewrite: "视频文案改写", replication_text_rewrite_short: "短文案改写",
  chat_deepseek: "AI 对话",
};

export function creditTransactionView(tx: CreditTransaction) {
  if (tx.amount === 0) return null;
  const amount = Number.isFinite(tx.amount) ? tx.amount : null;
  const service = tx.service ?? "";
  const usage = tx.meta?.entity_type === "agent_run" ? "智能创作" : SERVICES[service]
    ?? (/layer.*edit/.test(service) ? "图层修改" : /layer/.test(service) ? "图片分层" : /^image/.test(service) ? "图片生成"
      : /replication.*analy/.test(service) ? "参考视频分析" : /replication.*rewrit/.test(service) ? "视频文案改写"
      : /^video/.test(service) ? "视频生成" : /understand|vision/.test(service) ? "图片理解" : "云端创作");
  const labels: Record<string, string> = {
    grant: "积分到账", expire: "积分到期", adjust: "积分调整",
    refund: amount != null && amount < 0 ? "订单退款 · 积分收回" : "订单退款 · 积分退回",
  };
  const title = ["hold", "confirm", "rollback"].includes(tx.kind)
    ? `${usage}${amount != null && amount > 0 ? " · 积分退回" : ""}`
    : labels[tx.kind] ?? "积分变动";
  const time = new Date(tx.created_at);
  return { title,
    time: Number.isNaN(time.getTime()) ? "时间暂不可用" : time.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
    amount: amount == null ? "金额待确认" : `${amount > 0 ? "+" : "−"}${Math.abs(amount).toLocaleString("zh-CN")} Bcoin`,
    direction: amount == null ? "neutral" : amount > 0 ? "in" : "out",
  };
}
