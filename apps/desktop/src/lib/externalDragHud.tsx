import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ArrowUpRight } from "lucide-react";
import { ExternalDragProjection } from "./ExternalDragProjection";

function ExternalDragHud({ sourceRect }: { sourceRect?: DOMRect }) {
  const [viewport, setViewport] = useState(() => new DOMRect(0, 0, innerWidth, innerHeight));
  useEffect(() => {
    const resize = () => setViewport(new DOMRect(0, 0, innerWidth, innerHeight));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return <>
    <ExternalDragProjection source={sourceRect ?? null} viewport={viewport}/>
    <div className="external-drag-hud" role="status">
      <div className="external-drag-hud-mark" aria-hidden="true"><i/><ArrowUpRight size={18}/></div>
      <h2>拖到其他应用中使用</h2>
      <p>保持按住，移到目标应用后松开</p>
      <div className="external-drag-hud-foot">Esc 取消</div>
    </div>
  </>;
}

export function mountExternalDragHud(container: HTMLElement, sourceRect?: DOMRect) {
  const root = createRoot(container);
  flushSync(() => root.render(<ExternalDragHud sourceRect={sourceRect}/>));
  return () => root.unmount();
}
