import { useEffect, useRef, type RefObject } from "react";

const depths = [-.42, .35, 1];
const matrices = [{ columns: 5, rows: 3, size: 2.1 }, { columns: 5, rows: 3, size: 1.8 }, { columns: 3, rows: 3, size: 3.2 }];

/** Decorative projection only; no draft, pointer target or generation state. */
export function ComposerProjection({ dockRef }: { dockRef: RefObject<HTMLElement> }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current, dock = dockRef.current;
    if (!root || !dock) return;
    const canvas = root.querySelector("canvas")!;
    const context = canvas.getContext("2d")!;
    const arc = root.querySelector(".composer-projection-arc path")!;
    const clusters = [...root.querySelectorAll<SVGElement>(".composer-cross-matrix")];
    const surface = root.querySelector<HTMLElement>(".composer-projection-surface")!;
    const hint = root.querySelector<HTMLElement>(".composer-reference-hint")!;
    const region = dock.closest(".library-composer")?.parentElement ?? dock.closest(".canvas-workspace") ?? dock.parentElement!;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0, height = 0, left = 0, top = 0, color = "", tick = 0, visible = true;
    let pointer = { x: 0, y: 0 }, drift = { x: 0, y: 0 };
    let timer: ReturnType<typeof setInterval> | undefined;
    const scale = Math.min(devicePixelRatio || 1, 2);
    function draw() {
      context.clearRect(0, 0, width, height);
      const time = reduced.matches ? 0 : performance.now();
      for (let y = 8; y < height; y += 19) for (let x = 9; x < width; x += 19) {
        const seed = (x * 37 + y * 71) % 997;
        const wave = (Math.sin(time / (620 + seed) + seed) + 1) / 2;
        const flash = (time + seed * 21) % (3900 + seed * 4) < 140 ? .24 : 0;
        const near = Math.max(0, 1 - Math.hypot(x - width / 2 - pointer.x, y - height / 2 - pointer.y) / 190);
        context.globalAlpha = .12 + wave * .24 + flash + near * .12;
        context.fillStyle = color;
        context.fillRect(x, y, seed % 9 === 0 ? 1.8 : 1, seed % 9 === 0 ? 1.8 : 1);
      }
      drift.x += (pointer.x - drift.x) * .14;
      drift.y += (pointer.y - drift.y) * .14;
      clusters.forEach((cluster, index) => {
        const depth = reduced.matches ? 0 : depths[index];
        cluster.style.transform = `translate(${Math.max(-16, Math.min(16, drift.x * .035)) * depth}px,${Math.max(-11, Math.min(11, drift.y * .035)) * depth}px)`;
        const slot = Math.floor(time / 3200), age = time % 3200 - 600 - (slot * 347 % 1100);
        const blink = !reduced.matches && index === slot % 3 && age >= 0 && age < 320;
        cluster.style.visibility = blink && (age < 80 || age >= 160 && age < 240) ? "hidden" : "visible";
      });
    }
    function measure() {
      const bounds = region.getBoundingClientRect(), box = dock!.getBoundingClientRect();
      const project = (dock!.querySelector(".library-composer-target") ?? dock!.querySelector(".composer-mode-picker > button"))!.getBoundingClientRect();
      // This child effect can run before the parent mounts EditorView on a mode switch.
      const writingHost = dock!.querySelector<HTMLElement>(".composer-description")!;
      const writingLeft = writingHost.getBoundingClientRect().left + parseFloat(getComputedStyle(writingHost).paddingLeft);
      left = bounds.left; top = Math.min(box.top, project.top) - 70;
      width = bounds.width; height = Math.max(1, Math.min(innerHeight, bounds.bottom + 24) - top);
      Object.assign(root!.style, { left: `${left - box.left}px`, top: `${top - box.top}px`, width: `${width}px`, height: `${height}px` });
      canvas.width = width * scale; canvas.height = height * scale;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      const t = (project.left + project.width / 2 - left) / width;
      const bow = Math.min(36, width * .05);
      const y = project.top + project.height / 2 - top + 4 * bow * t * (1 - t);
      const path = `M0 ${y} Q${width / 2} ${y - 2 * bow} ${width} ${y}`;
      arc.setAttribute("d", path);
      arc.closest("svg")!.setAttribute("viewBox", `0 0 ${width} ${height}`);
      // The same mask softens blur, tint and dots; outside the writing area the library stays visible.
      const start = writingLeft - left - 72, end = box.right - left + 56;
      const span = end - start;
      const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><filter id="f"><feGaussianBlur stdDeviation="12.5"/></filter><linearGradient id="s" gradientUnits="userSpaceOnUse" x1="${start}" x2="${end}"><stop stop-color="white" stop-opacity="0"/><stop offset="${96 / span}" stop-color="white"/><stop offset="${1 - 96 / span}" stop-color="white"/><stop offset="1" stop-color="white" stop-opacity="0"/></linearGradient><mask id="v"><path d="${path} L${width + 50} ${height + 50} L-50 ${height + 50}Z" fill="white" filter="url(#f)"/></mask></defs><rect width="100%" height="100%" fill="url(#s)" mask="url(#v)"/></svg>`;
      surface.style.maskImage = canvas.style.maskImage = `url("data:image/svg+xml,${encodeURIComponent(mask)}")`;
      hint.style.top = `${y - bow + 9}px`;
      const writingTop = writingHost.getBoundingClientRect().top - top;
      const groups = [
        { x: Math.max(26, project.left - left - 105), y: writingTop + 72 },
        { x: box.right - left - 180, y: writingTop + 60 },
        { x: Math.min(width - 60, box.right - left + 25), y: writingTop + 96 },
      ];
      clusters.forEach((cluster, index) => Object.assign(cluster.style, { left: `${groups[index].x}px`, top: `${groups[index].y}px` }));
      color = getComputedStyle(root!).getPropertyValue("--projection-dot").trim();
      draw();
    }
    function motion() {
      if (timer) clearInterval(timer);
      timer = undefined;
      const paused = document.hidden || !visible || reduced.matches;
      if (!paused) timer = setInterval(draw, 70);
      if (visible && !document.hidden) draw();
    }
    function moved(event: PointerEvent) {
      pointer = { x: event.clientX - left - width / 2, y: event.clientY - top - height / 2 };
    }
    function scheduleMeasure() { cancelAnimationFrame(tick); tick = requestAnimationFrame(measure); }
    const resize = new ResizeObserver(scheduleMeasure);
    resize.observe(dock); resize.observe(region);
    const intersection = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; motion(); });
    intersection.observe(dock);
    const theme = new MutationObserver(scheduleMeasure);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    window.addEventListener("pointermove", moved, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    document.addEventListener("visibilitychange", motion);
    reduced.addEventListener("change", motion);
    measure(); motion();
    return () => {
      clearInterval(timer); cancelAnimationFrame(tick); resize.disconnect(); intersection.disconnect(); theme.disconnect();
      window.removeEventListener("pointermove", moved); window.removeEventListener("resize", scheduleMeasure);
      document.removeEventListener("visibilitychange", motion); reduced.removeEventListener("change", motion);
    };
  }, [dockRef]);
  return <div ref={rootRef} className="composer-projection" aria-hidden="true">
    <div className="composer-projection-surface" />
    <canvas className="composer-projection-dots" />
    {matrices.map(({ columns, rows, size }, index) => <svg key={index} className={`composer-cross-matrix depth-${index}`} width={columns * 13} height={rows * 13} viewBox={`0 0 ${columns * 13} ${rows * 13}`}>
      {Array.from({ length: columns * rows }, (_, point) => {
        const x = 6 + point % columns * 13, y = 6 + Math.floor(point / columns) * 13;
        return <path key={point} d={`M${x - size} ${y - size}l${size * 2} ${size * 2}m0 ${-size * 2}l${-size * 2} ${size * 2}`} />;
      })}
    </svg>)}
    <svg className="composer-projection-arc" preserveAspectRatio="none"><path /></svg>
    <span className="composer-reference-hint">双击添加素材</span>
  </div>;
}
