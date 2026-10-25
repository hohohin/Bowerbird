import { useEffect, useRef } from "react";

// FIELD STUDY 05: 680ms irregular bursts at 12Hz, with a 6500ms lit rest.
function signalFrames(index: number): Keyframe[] {
  let seed = 157 + index * 23;
  const random = () => { seed = seed * 16807 % 2147483647; return (seed - 1) / 2147483646; };
  const frames: Keyframe[] = [{ offset: 0, opacity: .38 }];
  let time = 0, dark = true;
  while (true) {
    time += (500 / 12) * (1 + .65 * (random() - .5) * 1.4);
    if (time >= 680 * .94) break;
    frames.push({ offset: time / 7180, opacity: dark ? .057 * (.7 + random() * .3) : .38 * (1 - .65 * random() * .25) });
    dark = !dark;
  }
  frames.push({ offset: 680 / 7180, opacity: .38 }, { offset: 1, opacity: .38 });
  return frames.map(frame => ({ ...frame, easing: "steps(1,end)" }));
}

/** Decorative signals stay behind cards and pause while the document is hidden. */
export function ProjectManagerBackdrop() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current!;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animations: Animation[] = [];
    const update = () => {
      element.dataset.paused = String(document.hidden);
      animations.forEach(animation => document.hidden ? animation.pause() : animation.play());
    };
    const start = () => {
      animations.forEach(animation => animation.cancel());
      const nodes = Array.from(element.querySelectorAll(".pm-signal"));
      animations = motion.matches ? [] : nodes.map((node, index) => {
        const animation = node.animate(signalFrames(index), { duration: 7180, iterations: Infinity, easing: "linear" });
        animation.currentTime = (index * 7180 / nodes.length + 680) % 7180;
        return animation;
      });
      update();
    };
    start();
    document.addEventListener("visibilitychange", update);
    motion.addEventListener("change", start);
    return () => {
      animations.forEach(animation => animation.cancel());
      document.removeEventListener("visibilitychange", update);
      motion.removeEventListener("change", start);
    };
  }, []);
  return <div ref={root} className="project-manager-ambient" aria-hidden="true">
    <svg viewBox="0 0 1120 790" preserveAspectRatio="none">
      <g className="pm-signal pm-signal-top"><path d="M543 32h8m-4-4v8"/><text x="566" y="36">WORKSPACE / DIRECTORY</text><path d="M567 46h2m8 0h2m8 0h2m8 0h2m8 0h2" strokeWidth="2"/></g>
      <g className="pm-signal"><path d="M15 168v40m0 8v14m0 8v5M10 186h10M10 394h10m-5-5v10"/></g>
      <g className="pm-signal"><path d="M1104 172v52m0 8v11M1099 182h10m-10 8h6m-6 8h10M1099 420h10m-5-5v10"/></g>
      <g className="pm-signal"><path d="M433 18h67m12 0h20M16 524v74m0 10v18M1104 556v48m0 9v18"/></g>
      <g className="pm-signal"><path d="M377 474h8m-4-4v8M727 474h8m-4-4v8"/></g>
      <g className="pm-signal"><path d="M18 681h2m6 0h2m6 0h2M18 689h2m6 0h2M18 697h2m6 0h2m6 0h2" strokeWidth="2"/></g>
      <g className="pm-signal"><path d="M823 760h14m-7-7v14M847 760h21m7 0h4M1100 747v24h-16M885 758h2m6 0h2m6 0h2"/></g>
    </svg>
  </div>;
}
