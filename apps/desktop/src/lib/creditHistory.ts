import type { CreditTransaction } from "./types";

const SERVICES: Record<string, string> = {
  image_hd: "图片生成 · 高清", image_fast: "图片生成 · 快速", image_lite: "图片生成 · 轻量", image_sd: "图片生成 · 标准",
  classification: "素材自动分类", understand: "图片理解", reverse: "图片反推", rename: "素材命名",
  video_replication_analyze: "参考视频分析", video_replication_rewrite: "视频文案改写",
  replication_video_analysis: "参考视频分析", replication_text_rewrite: "视频文案改写", replication_text_rewrite_short: "短文案改写",
};
const STATUSES: Record<string, string> = { succeeded: "任务完成", failed: "任务失败", cancelled: "任务已取消", budget_exceeded: "已达预算上限", expired: "任务已过期" };

export function creditTransactionView(tx: CreditTransaction) {
  const amount = Number.isFinite(tx.amount) ? tx.amount : null;
  const labels: Record<string, [string, string]> = {
    grant: ["积分到账", "本次发放的积分已计入余额。"],
    hold: ["预留积分", "任务开始时暂时占用，结算后多余部分会返还。"],
    confirm: amount != null && amount > 0 ? ["多余预留返还", "实际用量低于预留，多余积分已返还。"]
      : amount === 0 ? ["结算完成", "本条仅记录结算，不会再次扣减余额。"] : ["结算调整", "本次结算产生的余额调整。"],
    rollback: ["积分退回", "本次任务预留的积分已退回；可用余额以最新权益为准。"],
    expire: ["积分到期", "有有效期的历史积分到期后扣除。"],
    refund: amount != null && amount < 0 ? ["退款回收积分", "订单退款后回收对应积分，并非任务消费。"] : ["退款调整", "退款产生的积分余额调整。"],
    adjust: ["余额调整", "账号积分余额发生调整。"],
  };
  const [title, description] = labels[tx.kind] ?? ["积分变动", "积分记录已更新，以显示的余额变动为准。"];
  const service = tx.service ?? "";
  const usage = tx.meta?.entity_type === "agent_run" ? "智能创作任务" : SERVICES[service]
    ?? (/layer.*edit/.test(service) ? "图层修改" : /layer/.test(service) ? "图片分层" : /^image/.test(service) ? "图片生成"
      : /replication.*analy/.test(service) ? "参考视频分析" : /replication.*rewrit/.test(service) ? "视频文案改写"
      : /^video/.test(service) ? "视频生成" : /understand|vision/.test(service) ? "图片理解" : service ? "云端任务" : "账号积分");
  const status = tx.meta?.entity_type === "agent_run" ? STATUSES[tx.meta.final_status] : undefined;
  const time = new Date(tx.created_at);
  return { title, description, usage, status,
    time: Number.isNaN(time.getTime()) ? "时间暂不可用" : time.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
    amount: amount == null ? "暂不可用" : amount === 0 ? "余额不变" : `${amount > 0 ? "+" : "−"}${Math.abs(amount).toLocaleString("zh-CN")} Bcoin`,
    direction: amount == null || amount === 0 ? "neutral" : amount > 0 ? "in" : "out",
  };
}
