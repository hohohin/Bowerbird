import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { GuideStep } from "../lib/onboardingRoutes";

interface Bounds { x: number; y: number; width: number; height: number }

/** The spotlight and the framed control can have different bounds. Both pass pointer events through. */
export function OnboardingSpotlight({ step, children, minimized, ringOpen = false }: { step: GuideStep; children: ReactNode; minimized: boolean; ringOpen?: boolean }) {
  const card = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<{ hole: Bounds | null; highlight: Bounds | null; left: number; top: number; width: number }>({ hole: null, highlight: null, left: 16, top: 80, width: 416 });
  useLayoutEffect(() => {
    function measure() {
      const rects = Array.from(document.querySelectorAll(step.target)).map(el => el.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.height > 0);
      const browser = document.querySelector('.explore-workspace.is-open .explore-browser')?.getBoundingClientRect();
      const browserRight = browser && browser.width > 0 ? browser.right : 0;
      const width = Math.min(416, window.innerWidth - 32);
      const height = card.current?.getBoundingClientRect().height ?? 260;
      let hole: Bounds | null = null;
      let highlight: Bounds | null = null;
      const framed = step.highlight && Array.from(document.querySelectorAll(step.highlight)).map(el => el.getBoundingClientRect()).find(r => r.width > 0 && r.height > 0);
      if (framed && !minimized) highlight = { x: framed.left - 3, y: framed.top - 3, width: framed.width + 6, height: framed.height + 6 };
      if (rects.length && step.scene !== "explore" && !minimized) {
        const x = Math.max(0, Math.min(...rects.map(r => r.left)) - 7);
        const y = Math.max(0, Math.min(...rects.map(r => r.top)) - 7);
        hole = { x, y, width: Math.min(window.innerWidth, Math.max(...rects.map(r => r.right)) + 7) - x,
          height: Math.min(window.innerHeight, Math.max(...rects.map(r => r.bottom)) + 7) - y };
      }
      let left = window.innerWidth - width - 20, top = 80;
      if (step.scene === "explore" && rects[0]) {
        left = rects[0].left + 16; top = rects[0].top + 16;
      }
      const ring = ringOpen ? document.querySelector(".caption-ring-svg")?.getBoundingClientRect() : null;
      const anchor = ring ? { x: ring.left, y: ring.top, width: ring.width, height: ring.height } : highlight ?? hole;
      if (anchor && anchor.height >= window.innerHeight * .8 && anchor.width < 100) {
        left = anchor.x + anchor.width + 16;
      } else if (anchor && anchor.height < window.innerHeight * .8) {
        left = anchor.x;
        top = anchor.y + anchor.height + 16;
        if ((anchor.y > 90 || ringOpen) && anchor.x + anchor.width + width + 32 < window.innerWidth) {
          left = anchor.x + anchor.width + 16; top = anchor.y;
        } else if (top + height > window.innerHeight - 16) top = anchor.y - height - 16;
      }
      // The native webpage is a separate surface. Keep the explanatory card on
      // the app/canvas side, where it can never be covered by WebView2.
      left = Math.max(browserRight + 16, Math.min(left, window.innerWidth - width - 16));
      const next = { hole, highlight, width: Math.max(180, Math.min(width, window.innerWidth - left - 16)), left,
        top: Math.max(16, Math.min(top, window.innerHeight - height - 16)) };
      setLayout(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    }
    measure();
    const timer = setInterval(measure, 120);
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    return () => { clearInterval(timer); window.removeEventListener("resize", measure); document.removeEventListener("scroll", measure, true); };
  }, [step.target, step.highlight, step.scene, minimized, ringOpen]);
  const { hole, highlight } = layout;
  return <>
    {hole && createPortal(<svg data-onboarding-dim-browser className={"onboarding-spotlight" + (ringOpen ? " is-ring-open" : "")} aria-hidden="true" width="100%" height="100%">
      <defs><mask id="onboarding-spotlight-mask"><rect width="100%" height="100%" fill="white" />
        <rect data-spotlight-hole x={hole.x} y={hole.y} width={hole.width} height={hole.height} rx="10" fill="black" />
      </mask></defs>
      <rect width="100%" height="100%" fill="rgba(0,0,0,.56)" mask="url(#onboarding-spotlight-mask)" />
      {highlight && <rect data-spotlight-highlight className="onboarding-control-frame" x={highlight.x} y={highlight.y} width={highlight.width} height={highlight.height} rx="7" />}
    </svg>, document.body)}
    {createPortal(<aside ref={card} className={"onboarding-lesson onboarding-spotlight-card" + (ringOpen ? " is-ring-open" : "")} aria-label="入门任务清单"
      style={{ left: layout.left, top: layout.top, width: layout.width }}>{children}</aside>, document.body)}
  </>;
}

export function ExploreDragDemo() {
  return <figure className="onboarding-drag-demo" aria-label="拖图演示：按住网页图片，拖到右侧画板后松开">
    <svg viewBox="0 0 288 116" role="img" aria-label="从网页到画板的虚拟鼠标拖动示意">
      <rect x="1" y="1" width="102" height="112" rx="8" className="demo-panel" />
      <rect x="179" y="1" width="108" height="112" rx="8" className="demo-panel" />
      <text x="52" y="23" textAnchor="middle">小红书网页</text><text x="233" y="23" textAnchor="middle">右侧画板</text>
      <path d="M55 68 C110 37 160 92 226 66" fill="none" stroke="currentColor" strokeDasharray="4 5" opacity=".55" />
      <path d="m217 62 10 4-6 8" fill="none" stroke="currentColor" />
      <g className="demo-image"><rect x="26" y="43" width="54" height="43" rx="5" fill="#c5b899" />
        <path d="m30 78 15-20 12 13 8-9 11 16" fill="#64765b" /><circle cx="67" cy="53" r="5" fill="#fff7df" /></g>
      <path className="demo-cursor" d="m55 66 2 23 6-6 5 10 5-3-6-9 9-1z" fill="white" stroke="#20251e" strokeWidth="1.5" />
    </svg>
    <figcaption>按住图片 → 拖到画板 → 松开采集</figcaption>
  </figure>;
}
