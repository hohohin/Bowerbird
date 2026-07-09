import { useStore } from "../store";

/**
 * codex 状态指示器（一个圆），挂在顶部工具栏最右侧。
 *
 * 四态：
 * - 空闲：只显示静态圆环
 * - 反推中：圆环旋转（border 顶部高亮 + animate-spin）
 * - 有排队：旋转圆环内嵌一个实心小圆，数字 = 反推队列里待跑的张数
 * - 生成中：六格 pulse loader（uiverse spotty-starfish-76）
 *
 * 状态全部来自全局 store：反推（describingId / describeQueue）、生成（generating）、
 * 导入即基础分析（autoAnalyzing，autoname 后台跑时由后端 codex://auto-active 推来）。
 * codex 调用是全局的——反推 / 创作板生成 / 导入基础分析都会触发，故指示器常驻顶栏
 * 而非只在创作板可见。并用时生成优先显示 loader，其次反推（带队列数），再次导入分析。
 */
export function CodexStatus() {
  const generating = useStore((s) => s.generating);
  const describingId = useStore((s) => s.describingId);
  const queueLen = useStore((s) => s.describeQueue.length);
  const autoAnalyzing = useStore((s) => s.autoAnalyzing);

  const describing = describingId !== null || queueLen > 0;
  // 反推或导入分析任一在跑 → 圆环旋转；队列数 badge 只反映反推队列（用户语义）。
  const analyzing = describing || autoAnalyzing > 0;

  const title = generating
    ? "codex 生成图像中…"
    : describing
      ? queueLen > 0
        ? `反推中（队列 ${queueLen}）`
        : "反推中…"
      : autoAnalyzing > 0
        ? `导入基础分析中（${autoAnalyzing}）`
        : "codex 空闲";

  if (generating) {
    return (
      <div className="codex-loader" title={title} aria-label={title}>
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
    );
  }

  if (analyzing) {
    return (
      <div className="relative flex h-5 w-5 items-center justify-center" title={title} aria-label={title}>
        <div className="absolute inset-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
        {queueLen > 0 && (
          <span className="relative flex h-3 w-3 items-center justify-center rounded-full bg-accent text-[9px] font-bold leading-none text-black">
            {queueLen}
          </span>
        )}
      </div>
    );
  }

  // 空闲：静态圆环
  return <div className="h-5 w-5 rounded-full border-2 border-muted/50" title={title} aria-label={title} />;
}
