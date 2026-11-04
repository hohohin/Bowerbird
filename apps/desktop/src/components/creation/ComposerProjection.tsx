import { useEffect, useRef, type RefObject } from "react";

const depths = [-.42, .35, 1];
const crosses = Array.from({ length: 28 }, (_, index) => ({ x: 6 + index % 7 * 17, y: 6 + Math.floor(index / 7) * 17 }));

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
        cluster.style.transform = `translate(${drift.x * depth * .035}px,${drift.y * depth * .035}px)`;
      });
    }
    function measure() {
      const bounds = region.getBoundingClientRect(), box = dock!.getBoundingClientRect();
      const project = (dock!.querySelector(".library-composer-target") ?? dock!.querySelector(".composer-mode-picker"))!.getBoundingClientRect();
      left = bounds.left; top = Math.min(box.top, project.top) - 70;
      width = bounds.width; height = Math.max(1, Math.min(innerHeight, bounds.bottom + 24) - top);
      Object.assign(root!.style, { left: `${left - box.left}px`, top: `${top - box.top}px`, width: `${width}px`, height: `${height}px` });
      canvas.width = width * scale; canvas.height = height * scale;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      const t = (project.left + project.width / 2 - left) / width;
      const bow = Math.min(60, width * .05);
      const y = project.top + Math.min(project.height, 27) / 2 - top + 4 * bow * t * (1 - t);
      const path = `M0 ${y} Q${width / 2} ${y - 2 * bow} ${width} ${y}`;
      arc.setAttribute("d", path);
      arc.closest("svg")!.setAttribute("viewBox", `0 0 ${width} ${height}`);
      const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><filter id="f"><feGaussianBlur stdDeviation="12.5"/></filter></defs><path d="${path} L${width + 50} ${height + 50} L-50 ${height + 50}Z" fill="white" filter="url(#f)"/></svg>`;
      surface.style.maskImage = canvas.style.maskImage = `url("data:image/svg+xml,${encodeURIComponent(mask)}")`;
      hint.style.top = `${y - bow + 9}px`;
      color = getComputedStyle(root!).getPropertyValue("--projection-dot").trim();
      draw();
    }
    function motion() {
      if (timer) clearInterval(timer);
      timer = undefined;
      const paused = document.hidden || !visible || reduced.matches;
      root!.classList.toggle("is-paused", paused);
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
    {depths.map((depth, index) => <svg key={depth} className={`composer-cross-matrix depth-${index}`} viewBox="0 0 118 65">
      {crosses.map(({ x, y }) => <path key={`${x}-${y}`} d={`M${x - 2} ${y - 2}l4 4m0 -4l-4 4`} />)}
    </svg>)}
    <svg className="composer-projection-arc" preserveAspectRatio="none"><path /></svg>
    <span className="composer-reference-hint">双击添加素材</span>
  </div>;
}
