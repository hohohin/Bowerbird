import { useId, useLayoutEffect, useRef, type CSSProperties } from "react";

const feather = 4;
const depths = [-.42, .35, 1];
const matrices = [{ columns: 5, rows: 3, size: 2.1 }, { columns: 5, rows: 3, size: 1.8 }, { columns: 3, rows: 3, size: 3.2 }];
// Approved film: 72% contour detail, with a stable neutral reading surface.
const films = [
  { theme: "dark", slopes: [.1584, .1728, .1872], base: [.10, .115, .14] },
  { theme: "light", slopes: [-.1656, -.1584, -.144], base: [.94, .95, .97] },
];

/** Decorative projection only; no draft, pointer target or generation state. */
export function ComposerProjection({ collapsed }: { collapsed: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const filmId = `composer-contour-${useId().replace(/:/g, "")}`;
  useLayoutEffect(() => {
    const root = rootRef.current, dock = root?.parentElement;
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
      if (collapsed) return;
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
      // This child effect can run before the parent mounts EditorView on a mode switch.
      const writingHost = dock!.querySelector<HTMLElement>(".composer-description")!;
      const project = (dock!.querySelector(".library-composer-target") ?? (collapsed ? writingHost : dock!.querySelector(".composer-mode-picker > button")))!.getBoundingClientRect();
      left = bounds.left; top = Math.min(box.top, project.top) - 40;
      // The opening translation must not shorten the field once the dock settles.
      const openingOffset = new DOMMatrixReadOnly(getComputedStyle(dock!).transform).m42;
      width = bounds.width; height = Math.max(1, Math.min(innerHeight, bounds.bottom + 24) - top + openingOffset);
      Object.assign(root!.style, { left: `${left - box.left}px`, top: `${top - box.top}px`, width: `${width}px`, height: `${height}px` });
      canvas.width = width * scale; canvas.height = height * scale;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      const arcLeft = collapsed ? box.left - left - 16 : project.left - left - 36;
      const arcRight = box.right - left + (collapsed ? 16 : 28), span = arcRight - arcLeft;
      const t = (project.left + project.width / 2 - left - arcLeft) / span;
      const bow = collapsed ? 8 : Math.min(32, span * .04);
      const y = collapsed ? box.top - top + 8 : project.top + project.height / 2 - top + 4 * bow * t * (1 - t);
      const path = `M${arcLeft} ${y} Q${(arcLeft + arcRight) / 2} ${y - 2 * bow} ${arcRight} ${y}`;
      arc.setAttribute("d", path);
      const arcSvg = arc.closest("svg")!;
      arcSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      arcSvg.style.maskImage = `linear-gradient(90deg,transparent ${arcLeft}px,#000 ${arcLeft + 72}px,#000 ${arcRight - 72}px,transparent ${arcRight}px)`;
      // Center the feather on the local arc; the elliptical field has no vertical side boundary.
      const curveY = (x: number) => { const position = (x - arcLeft) / span; return y - 4 * bow * position * (1 - position); };
      const edgeLeft = curveY(-50), edgeRight = curveY(width + 50);
      const cap = `M-50 ${edgeLeft} Q${width / 2} ${2 * curveY(width / 2) - (edgeLeft + edgeRight) / 2} ${width + 50} ${edgeRight} L${width + 50} ${height + 50} L-50 ${height + 50}Z`;
      const cx = (arcLeft + arcRight) / 2;
      const tags = [...dock!.querySelectorAll('.library-composer-target, .composer-mode-picker > button')];
      const fadeLeft = Math.min(...tags.map(tag => tag.getBoundingClientRect().left), project.left) - left;
      const fadeRight = (dock!.querySelector('.composer-send')?.getBoundingClientRect().right ?? box.right) - left;
      const fadeWidth = fadeRight - fadeLeft + 220;
      const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><filter id="f" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="${feather / 4}"/></filter><mask id="top"><path d="${cap}" fill="white" filter="url(#f)"/></mask><linearGradient id="field" gradientUnits="userSpaceOnUse" x1="${fadeLeft - 110}" x2="${fadeRight + 110}"><stop stop-color="white" stop-opacity="0"/><stop offset="${110 / fadeWidth}" stop-color="white"/><stop offset="${1 - 110 / fadeWidth}" stop-color="white"/><stop offset="1" stop-color="white" stop-opacity="0"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#field)" mask="url(#top)"/></svg>`;
      surface.style.maskImage = canvas.style.maskImage = `url("data:image/svg+xml,${encodeURIComponent(mask)}")`;
      hint.style.top = `${y - bow + 9}px`;
      hint.style.left = `${cx}px`;
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
      const paused = collapsed || document.hidden || !visible || reduced.matches;
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
    if (!collapsed) window.addEventListener("pointermove", moved, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    document.addEventListener("visibilitychange", motion);
    reduced.addEventListener("change", motion);
    measure(); motion();
    return () => {
      clearInterval(timer); cancelAnimationFrame(tick); resize.disconnect(); intersection.disconnect(); theme.disconnect();
      window.removeEventListener("pointermove", moved); window.removeEventListener("resize", scheduleMeasure);
      document.removeEventListener("visibilitychange", motion); reduced.removeEventListener("change", motion);
    };
  }, [collapsed]);
  return <div ref={rootRef} className="composer-projection" aria-hidden="true" style={{
    "--projection-contour-dark": `url(#${filmId}-dark)`,
    "--projection-contour-light": `url(#${filmId}-light)`,
  } as CSSProperties}>
    <svg width="0" height="0" className="composer-projection-filters">
      <defs>{films.map(({ theme, slopes, base }) => <filter key={theme} id={`${filmId}-${theme}`} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
        <feColorMatrix type="saturate" values="0" />
        <feConvolveMatrix order="3" kernelMatrix="0 -1 0 -1 4 -1 0 -1 0" preserveAlpha="true" edgeMode="duplicate" />
        <feComponentTransfer>
          <feFuncR type="linear" slope={slopes[0]} intercept={base[0]} />
          <feFuncG type="linear" slope={slopes[1]} intercept={base[1]} />
          <feFuncB type="linear" slope={slopes[2]} intercept={base[2]} />
        </feComponentTransfer>
      </filter>)}</defs>
    </svg>
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
