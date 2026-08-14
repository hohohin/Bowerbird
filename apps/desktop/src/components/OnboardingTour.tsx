import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Sparkles } from "lucide-react";
import { useStore } from "../store";
import { ModalShell } from "./ModalShell";

type StepDef = { title?: string; body: string; side?: "below" | "right" };

const STEP_DEFS: Record<number, StepDef> = {
  1: {
    title: "先来创建一个项目吧",
    body: "点击后，请选择「初始引导」文件夹，然后点击右下角「选择文件夹」按钮，创建项目。",
  },
  2: {
    body:
      "稍等片刻，正在导入文件夹内的图片。\n\n" +
      "tips：后续您也可以像这样选择您的素材文件夹，一键导入所有素材并建立为项目，建议文件夹内只存放图片素材。",
  },
  3: {
    body: "项目建好了，预设图已就位。右键点最上面这张图，选「复用生成提示词」。",
  },
  4: {
    side: "right",
    body: "点「复用生成提示词」，把它的提示词和参考图带进创作板。",
  },
  5: {
    body: "你可以像这样，直接用文字和素材写出你的想法——需要素材的时候，在左侧点击想要的素材即可。",
  },
  6: {
    body: "先点一下编辑框，把光标放进去。",
  },
  7: {
    body: "再点左侧的这张图片，把它加进编辑框——下方就会出现它的可选维度。",
  },
  8: {
    body: "经过分析的素材会具备不同的维度，你可以通过维度来更好地控制生成时的参数。对于未经分析的素材，你也可以直接文字描述想要参考/控制的内容。",
  },
  9: {
    body: "点击「构图」维度，添加到编辑框中。",
  },
};

function bubblePosition(rect: DOMRect, side: "below" | "right"): CSSProperties {
  const bubbleH = 150;
  const bubbleW = 320;
  const margin = 12;
  if (side === "right") {
    const fitsRight = rect.right + bubbleW + margin < window.innerWidth;
    const left = fitsRight ? rect.right + margin : Math.max(12, rect.left - bubbleW - margin);
    const top = Math.max(12, Math.min(rect.top, window.innerHeight - bubbleH - margin));
    return { top, left };
  }
  const below = rect.bottom + bubbleH + margin < window.innerHeight;
  const top = below ? rect.bottom + margin : Math.max(12, rect.top - bubbleH - margin);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - bubbleW - margin));
  return { top, left };
}

/** 编辑框内文本末尾坐标（step 6 虚拟鼠标要指向光标该落的位置）：取 .ProseMirror 内最后一个非空
 * 文本节点的末尾——真正的文本末尾，而非段落块容器的末尾（避免落到行中间）。 */
function editorTextEndCoords(): { x: number; y: number } | null {
  const pm = document.querySelector(
    '[data-tour="creation-editor"] .ProseMirror',
  ) as HTMLElement | null;
  if (!pm) return null;
  const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
  let lastText: Text | null = null;
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (t.data.length > 0) lastText = t;
  }
  if (lastText) {
    const range = document.createRange();
    range.setEnd(lastText, lastText.data.length);
    range.collapse(false);
    const r = range.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) return { x: r.right, y: r.top + r.height / 2 };
  }
  // 回退：最后一个块末尾。
  const lastBlock = pm.querySelector("p:last-of-type") ?? pm.lastElementChild;
  if (lastBlock) {
    const range = document.createRange();
    range.selectNodeContents(lastBlock);
    range.collapse(false);
    const r = range.getBoundingClientRect();
    return { x: r.right, y: r.top + r.height / 2 };
  }
  const r = pm.getBoundingClientRect();
  return { x: r.left + 16, y: r.bottom - 14 };
}

/**
 * 新手引导 tour（阶段 B，替代首启自动注入）。自写 spotlight（box-shadow 挖洞 z-70 + pulse ring
 * + 气泡 z-71）+ 虚拟鼠标（z-72，移动到目标 + 脉冲点击示意），零依赖。步骤：
 * 0 入口弹窗 → 1 新建项目 → 2 导入中 → 3 首图右键 → 4 菜单复用 → 5 编辑框 →
 * 6 虚拟鼠标示意点编辑框（用户真点）→ 7 虚拟鼠标示意点 preset-05（用户真点 → 插入 chip、chips 出现）
 * → 8 高亮可选维度面板 → 9 虚拟鼠标示意点「构图」chip（用户真点）→ 10 结束语。
 * 推进：1→2 ProjectSection.create 选完文件夹；2→3【下一步】（tourImported 后）；
 * 3→4 右键首图（contextMenu）；4→5 点复用（boardOpen）；5→6【下一步】；
 * 6→7 用户真点编辑框；7→8 用户真点瀑布流图（board-asset-picked）；8→9【下一步】；
 * 9→10 用户真点维度 chip（CreationBoard 钩子）。
 */
export function OnboardingTour() {
  const tourActive = useStore((s) => s.tourActive);
  const tourStep = useStore((s) => s.tourStep);
  const tourImported = useStore((s) => s.tourImported);
  const setTourStep = useStore((s) => s.setTourStep);
  const endTour = useStore((s) => s.endTour);
  const boardOpen = useStore((s) => s.boardOpen);
  const assets = useStore((s) => s.assets);
  const contextMenu = useStore((s) => s.contextMenu);
  // tour step 3 锁定「罂粟夜宴」（生成图，有可复用的 prompt_raw）；不依赖 assets[0]（排序不定）。
  const yysyAsset = assets.find((a) => a.name === "罂粟夜宴");
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  const selector: string | null = (() => {
    if (!tourActive || tourStep <= 0 || tourStep >= 10) return null;
    if (tourStep === 1 || tourStep === 2) return `[data-tour="new-project"]`;
    if (tourStep === 3) return yysyAsset ? `#asset-${yysyAsset.id}` : null;
    if (tourStep === 4) return `[data-tour="ctx-reuse-gen"]`;
    if (tourStep === 5 || tourStep === 6) return `[data-tour="creation-editor"]`;
    if (tourStep === 7) return `[data-origin*="preset-05"]`;
    if (tourStep === 8) return `[data-tour="creation-keywords"]`;
    if (tourStep === 9) return `[data-dim="构图"]`;
    return null;
  })();

  // 测量 spotlight 锚点 rect；监听 resize/scroll + 定时兜底（首图加载/创作板挂载/右键菜单打开延迟）。
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

  // 虚拟鼠标坐标：step 6 指向编辑框文本末尾（光标应落处）；7/9 指向目标元素中心。
  useLayoutEffect(() => {
    if (tourStep !== 6 && tourStep !== 7 && tourStep !== 9) {
      setCursor(null);
      return;
    }
    const measure = () => {
      if (tourStep === 6) {
        setCursor(editorTextEndCoords());
        return;
      }
      const sel = tourStep === 7 ? `[data-origin*="preset-05"]` : `[data-dim="构图"]`;
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) {
        setCursor(null);
        return;
      }
      if (tourStep === 7) {
        const r0 = el.getBoundingClientRect();
        if (r0.bottom < 0 || r0.top > window.innerHeight) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
      const r = el.getBoundingClientRect();
      if (r.width === 0) {
        setCursor(null);
        return;
      }
      setCursor({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    };
    measure();
    const raf = requestAnimationFrame(measure);
    const t = setInterval(measure, 400);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(t);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [tourStep]);

  // step 3 → 4：用户右键首图打开菜单 → 高亮菜单内「复用生成提示词」。
  useEffect(() => {
    if (
      tourActive &&
      tourStep === 3 &&
      contextMenu &&
      yysyAsset &&
      contextMenu.assetId === yysyAsset.id
    ) {
      setTourStep(4);
    }
  }, [tourActive, tourStep, contextMenu, assets, setTourStep]);

  // step 4 → 5：点「复用生成提示词」→ reusePromptToBoard 开 boardOpen。
  useEffect(() => {
    if (tourActive && tourStep === 4 && boardOpen) setTourStep(5);
  }, [tourActive, tourStep, boardOpen, setTourStep]);

  // step 6 → 7：用户真实点击编辑框（onClick={focus}）。
  useEffect(() => {
    if (tourStep !== 6) return;
    const el = document.querySelector(`[data-tour="creation-editor"]`);
    if (!el) return;
    const onClick = () => setTourStep(7);
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [tourStep, setTourStep]);

  // step 7 → 8：用户真实点瀑布流图 → board-asset-picked（MasonryGrid 插 chip）。
  useEffect(() => {
    if (tourStep !== 7) return;
    const onPick = () => setTourStep(8);
    window.addEventListener("bowerbird://board-asset-picked", onPick as EventListener);
    return () => window.removeEventListener("bowerbird://board-asset-picked", onPick as EventListener);
  }, [tourStep, setTourStep]);

  if (!tourActive) return null;

  // step 0：引导入口弹窗（进入引导 / 跳过）。
  if (tourStep === 0) {
    return (
      <ModalShell
        title="把灵感变成下一张作品"
        eyebrow="Welcome to Bowerbird"
        description="花一分钟走一遍核心流程：导入素材、复用提示词、开始创作。"
        width="sm"
        onClose={endTour}
        footer={(
          <>
            <button type="button" onClick={endTour} className="app-modal-button">跳过引导</button>
            <button type="button" onClick={() => setTourStep(1)} className="app-modal-button is-primary">
              进入引导模式 <ArrowRight size={15} />
            </button>
          </>
        )}
      >
        <div className="setup-card flex items-start gap-3 p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white"><Sparkles size={18} /></span>
          <p className="text-xs leading-5 text-muted">你会创建第一个项目、导入预设素材，并把一张参考图的提示词带进创作板。</p>
        </div>
      </ModalShell>
    );
  }

  // step 10：结束语居中模态（下半部分列状容器，预留动图/链接教程）。
  if (tourStep >= 10) {
    return (
      <ModalShell
        title="第一条创作路径已完成"
        eyebrow="Tour complete"
        description="随时能在「环境状态 · 新手教程」重温本引导。"
        width="sm"
        onClose={endTour}
        footer={<button type="button" onClick={endTour} className="app-modal-button is-primary">开始使用</button>}
      >
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-lime/20 bg-lime/5 p-3 text-lime">
            <Sparkles size={18} />
            <span className="text-xs font-medium">素材已经进入创作工作流</span>
          </div>
          {/* 下一步建议：列状容器，「配置素材采集插件」是按钮，点击结束 tour 并唤起扩展配置面板 */}
          <div className="text-left">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">下一步建议</h3>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  endTour();
                  useStore.getState().setExtensionOnboardingForceOpen(true);
                }}
                className="setup-card flex w-full items-center justify-between px-3 py-3 text-left hover:bg-panel2"
              >
                <span>
                  <span className="block text-xs text-ink">配置素材采集插件</span>
                  <span className="mt-0.5 block text-[10px] text-muted">方便你把灵感收入巢中</span>
                </span>
                <span className="ml-2 shrink-0 text-xs text-accent">前往 →</span>
              </button>
            </div>
          </div>
      </ModalShell>
    );
  }

  const def = STEP_DEFS[tourStep];
  const text = def?.body ?? "";
  const title = def?.title;
  const side = def?.side ?? "below";
  const bubbleStyle: CSSProperties = rect ? bubblePosition(rect, side) : { top: 120, left: 120 };
  const awaitClick = tourStep === 6 || tourStep === 7 || tourStep === 9;

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
      {cursor && (
        <div className="tour-cursor" style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}>
          <div className="tour-cursor-ring" />
          <div className="tour-cursor-dot" />
        </div>
      )}
      <div className="tour-bubble" style={bubbleStyle}>
        <div className="rounded-lg border border-edge bg-panel p-3 shadow-2xl">
          {title && <div className="mb-1 text-sm font-semibold text-ink">{title}</div>}
          <p className="whitespace-pre-line text-sm leading-relaxed text-ink">{text}</p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <button onClick={endTour} className="shrink-0 text-xs text-muted hover:text-ink">
              跳过引导
            </button>
            {tourStep === 2 ? (
              tourImported ? (
                <button
                  onClick={() => setTourStep(3)}
                  className="rounded bg-accent px-3 py-1 text-xs font-medium text-black hover:opacity-90"
                >
                  下一步
                </button>
              ) : (
                <span className="text-[11px] text-muted">正在导入…</span>
              )
            ) : tourStep === 5 ? (
              <button
                onClick={() => setTourStep(6)}
                className="rounded bg-accent px-3 py-1 text-xs font-medium text-black hover:opacity-90"
              >
                下一步
              </button>
            ) : tourStep === 8 ? (
              <button
                onClick={() => setTourStep(9)}
                className="rounded bg-accent px-3 py-1 text-xs font-medium text-black hover:opacity-90"
              >
                下一步
              </button>
            ) : awaitClick ? (
              <span className="text-[11px] text-muted">点击高亮处继续</span>
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
