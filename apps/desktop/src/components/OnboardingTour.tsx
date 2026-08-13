import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";

const STEP_TEXT: Record<number, string> = {
  1: "点「导入文件夹」，在对话框里选「初始引导」文件夹（已为你定位好）。",
  2: "项目建好了，预设图已就位。右键点最上面这张图，选「复用生成提示词」。",
  3: "直接用文字写出你的想法；需要素材时，在左侧点一下素材即可加入。",
};

function bubblePosition(rect: DOMRect): CSSProperties {
  const bubbleH = 130;
  const margin = 12;
  const below = rect.bottom + bubbleH + margin < window.innerHeight;
  const top = below ? rect.bottom + margin : Math.max(12, rect.top - bubbleH - margin);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - 312));
  return { top, left };
}

/**
 * 新手引导 tour（阶段 B，替代首启自动注入）。
 * 步骤：①高亮「导入文件夹」（建项目）→ ②高亮首张预设图（右键复用）→ ③高亮创作板编辑框 → ④结束语。
 * 自写 spotlight（box-shadow 挖洞 z-70 + pulse ring + 气泡 z-71），零依赖。
 * step 1→2 由 Toolbar tour 分支 setTourStep(2)；step 2→3 由 boardOpen（复用开板）；step 3→4 由「完成」按钮。
 */
export function OnboardingTour() {
  const tourActive = useStore((s) => s.tourActive);
  const tourStep = useStore((s) => s.tourStep);
  const setTourStep = useStore((s) => s.setTourStep);
  const endTour = useStore((s) => s.endTour);
  const boardOpen = useStore((s) => s.boardOpen);
  const assets = useStore((s) => s.assets);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const selector: string | null = (() => {
    if (!tourActive || tourStep >= 4) return null;
    if (tourStep === 1) return `[data-tour="import-folder"]`;
    if (tourStep === 2) {
      const first = assets[0];
      return first ? `#asset-${first.id}` : null;
    }
    if (tourStep === 3) return `[data-tour="creation-editor"]`;
    return null;
  })();

  // 测量锚点 rect；监听 resize/scroll + 定时兜底（首图加载/创作板挂载延迟）。
  useLayoutEffect(() => {
    if (!selector) {
      setRect(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector(selector) as HTMLElement | null;
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    const raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const t = setInterval(measure, 400);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      clearInterval(t);
    };
  }, [selector, assets, boardOpen]);

  // step 2 → 3：用户右键首图 + 点「复用生成提示词」→ reusePromptToBoard 开 boardOpen。
  useEffect(() => {
    if (tourActive && tourStep === 2 && boardOpen) setTourStep(3);
  }, [tourActive, tourStep, boardOpen, setTourStep]);

  if (!tourActive) return null;

  // step 4：结束语居中模态。
  if (tourStep >= 4) {
    return createPortal(
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        role="dialog"
        aria-modal="true"
        aria-label="新手引导完成"
      >
        <div className="w-full max-w-md rounded-lg border border-edge bg-panel p-6 text-center shadow-2xl">
          <div className="mb-3 text-4xl">🐦</div>
          <h2 className="text-lg font-semibold text-ink">开始构建你的巢吧</h2>
          <p className="mt-2 text-sm text-muted">随时能在「环境状态 · 新手教程」重温本引导。</p>
          <button
            onClick={endTour}
            className="mt-5 rounded-md bg-accent px-5 py-2 text-sm font-medium text-black hover:opacity-90"
          >
            开始使用
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  const text = STEP_TEXT[tourStep] ?? "";
  const bubbleStyle: CSSProperties = rect ? bubblePosition(rect) : { top: 120, left: 120 };

  return createPortal(
    <>
      {rect && (
        <>
          <div
            className="tour-spotlight"
            style={{
              left: rect.left - 6,
              top: rect.top - 6,
              width: rect.width + 12,
              height: rect.height + 12,
            }}
          />
          <div
            className="tour-spotlight-ring"
            style={{
              left: rect.left - 2,
              top: rect.top - 2,
              width: rect.width + 4,
              height: rect.height + 4,
            }}
          />
        </>
      )}
      <div className="tour-bubble" style={bubbleStyle}>
        <div className="rounded-lg border border-edge bg-panel p-3 shadow-2xl">
          <p className="text-sm leading-relaxed text-ink">{text}</p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <button
              onClick={endTour}
              className="text-xs text-muted hover:text-ink"
            >
              跳过引导
            </button>
            {tourStep === 3 ? (
              <button
                onClick={() => setTourStep(4)}
                className="rounded bg-accent px-3 py-1 text-xs font-medium text-black hover:opacity-90"
              >
                完成
              </button>
            ) : (
              <span className="text-[11px] text-muted">按提示操作自动继续</span>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
