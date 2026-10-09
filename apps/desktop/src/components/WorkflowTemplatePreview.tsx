import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import type { TemplatePreviewCard, TemplatePreviewLink } from "../lib/workflowTemplatePreview";

export function WorkflowTemplatePreview({ cards, links, enclosed, disabled, onToggle }: {
  cards: TemplatePreviewCard[]; links: TemplatePreviewLink[]; enclosed: Set<string>; disabled: boolean; onToggle: (id: string) => void;
}) {
  const [zoom, setZoom] = useState(1), [images, setImages] = useState<Record<string, string>>({});
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => { let active = true; void api.getAssetsByIds([...new Set(cards.flatMap(card => card.assets))]).then(assets => {
    if (active) setImages(Object.fromEntries(assets.filter(asset => asset.thumb_path || asset.store_path).map(asset => [asset.id, convertFileSrc((asset.thumb_path || asset.store_path)!)])));
  }).catch(() => {}); return () => { active = false; }; }, [cards]);
  const minX = (cards.length ? Math.min(...cards.map(card => card.x)) : 0) - 36, minY = (cards.length ? Math.min(...cards.map(card => card.y)) : 0) - 36;
  const width = Math.max(400, ...cards.map(card => card.x - minX + card.width + 36)), height = Math.max(240, ...cards.map(card => card.y - minY + card.height + 36));
  const ports = (id: string, side: "input" | "output") => [...new Map(links.filter(link => (side === "input" ? link.to : link.from) === id).map(link => [link[side], link])).values()];
  return <section className="workflow-template-preview" aria-label="选区画板预览">
    <div className="workflow-template-preview-tools"><span>勾选卡片右上角，将其放入容器 · 内容只读</span>
      <button aria-label="缩小预览" onClick={() => setZoom(Math.max(.1, zoom - .1))}>−</button>
      <button aria-label="预览原始比例" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
      <button aria-label="放大预览" onClick={() => setZoom(Math.min(2, zoom + .1))}>+</button>
      <button onClick={() => setZoom(Math.min(1, (viewport.current?.clientWidth ?? 700) / width, (viewport.current?.clientHeight ?? 400) / height))}>适应选区</button>
    </div>
    <div className="workflow-template-preview-viewport" ref={viewport}>
      <div style={{ width: width * zoom, height: height * zoom }}><div className="workflow-template-preview-world" style={{ width, height, transform: `scale(${zoom})` }}>
        <svg width={width} height={height} aria-hidden="true">{links.map((link, index) => {
          const from = cards.find(card => card.id === link.from), to = cards.find(card => card.id === link.to); if (!from || !to) return null;
          const x1 = from.x - minX + from.width, y1 = from.y - minY + 65 + ports(from.id, "output").findIndex(port => port.output === link.output) * 24;
          const x2 = to.x - minX, y2 = to.y - minY + 65 + ports(to.id, "input").findIndex(port => port.input === link.input) * 24;
          return <path key={index} data-preview-link d={`M${x1},${y1} C${x1 + 60},${y1} ${x2 - 60},${y2} ${x2},${y2}`} />;
        })}</svg>
        {cards.map(card => <article key={card.id} data-preview-card={card.id} className={enclosed.has(card.id) ? "is-enclosed" : ""}
          style={{ left: card.x - minX, top: card.y - minY, width: card.width, height: card.height }}>
          <header><strong>{card.title}</strong><input type="checkbox" aria-label={`封装 ${card.title}`} checked={enclosed.has(card.id)} disabled={disabled} onChange={() => onToggle(card.id)} /></header>
          <div className="workflow-template-preview-content"><p>{card.body}</p>{card.assets.map(id => images[id] && <img key={id} src={images[id]} alt="输入素材" />)}</div>
          {(["input", "output"] as const).flatMap(side => ports(card.id, side).map((link, index) => <span key={`${side}-${link[side]}`} data-preview-port={side} className={`workflow-template-preview-port is-${side}`} style={{ top: 58 + index * 24 }}
            title={link.type === "signal" ? "触发" : link.type === "image" ? "图片" : link.type === "visual-profile" ? "视觉规范" : "文本"} />))}
        </article>)}
      </div></div>
    </div>
  </section>;
}
