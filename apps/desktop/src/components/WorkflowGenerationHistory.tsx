import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { History, Image as ImageIcon } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import { canvasSessionImages, workflowSessionIds } from "../lib/canvasSessionOutputs";
import type { WorkflowNode } from "../lib/canvasWorkflow";
import type { Asset, CanvasNode } from "../lib/types";
import { BoardChipPreview } from "./creation/BoardChipPreview";

export function WorkflowGenerationHistory({ node, graphNodes, onOpen }: {
  node: WorkflowNode; graphNodes: CanvasNode[]; onOpen: (node: CanvasNode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const ids = workflowSessionIds([node]);
  const rows = graphNodes.filter(card => card.kind === "prompt" && card.hiddenAt == null && ids.has(card.id))
    .sort((a, b) => b.createdAt - a.createdAt || [...ids].indexOf(b.id) - [...ids].indexOf(a.id));
  const outputs = new Map(rows.map(card => [card.id, [...new Set(canvasSessionImages(card, graphNodes).map(output => output.assetId!))]]));
  const coverKey = JSON.stringify([...new Set([...outputs.values()].flatMap(ids => ids.slice(0, 1)))]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    void api.getAssetsByIds(JSON.parse(coverKey)).then(value => { if (current) setAssets(value); })
      .catch(() => { if (current) setAssets([]); });
    return () => { current = false; };
  }, [open, coverKey]);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      if (rect) {
        const next = { left: Math.max(8, Math.min(rect.right - 320, window.innerWidth - 328)),
          top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - (popup.current?.offsetHeight ?? 320) - 8)) };
        setPosition(current => current.left === next.left && current.top === next.top ? current : next);
      }
    };
    place();
    const frame = requestAnimationFrame(() => { place(); (popup.current?.querySelector("button") ?? popup.current)?.focus(); });
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); setOpen(false); button.current?.focus(); }
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", place);
    // Canvas zoom and pan are CSS transforms, so observe the button's screen position.
    const timer = window.setInterval(place, 100);
    return () => {
      cancelAnimationFrame(frame); window.clearInterval(timer);
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);
  return <>
    <button ref={button} type="button" className="workflow-generation-history" aria-label="生成历史" aria-expanded={open}
      aria-controls={`generation-history-${node.id}`} aria-haspopup="dialog"
      onPointerDown={event => event.stopPropagation()} onClick={() => setOpen(value => !value)}>
      <History size={12} />生成历史{rows.length > 0 && <span>{rows.length}</span>}
    </button>
    {open && createPortal(<div ref={popup} id={`generation-history-${node.id}`} role="dialog" aria-label="生成历史" tabIndex={-1}
      className="workflow-generation-history-popover" style={position}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onContextMenu={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <strong>生成历史 <span>{rows.length}</span></strong>
      {!rows.length ? <p>暂无生成会话</p> : <ul>{rows.map((card, index) => {
        let saved: { text?: string; status?: string; provider?: string } = {};
        try { saved = JSON.parse(card.payloadJson); } catch { /* The snapshot can still be opened. */ }
        const status = ({ done: "已完成", succeeded: "已完成", running: "生成中", queued: "排队中", failed: "失败", cancelled: "已取消", canceled: "已取消" } as Record<string, string>)[saved.status ?? ""] ?? "已记录";
        const created = new Date(card.createdAt * 1000);
        const products = outputs.get(card.id)!;
        const cover = assets.find(asset => asset.id === products[0]);
        const thumbnail = cover?.thumb_path || cover?.store_path;
        return <li key={card.id}><button type="button" data-workflow-history-session={card.id} onClick={() => { setOpen(false); onOpen(card); }}>
          <span className="workflow-history-thumbnail" data-asset-id={thumbnail ? cover?.id : undefined}>
            {thumbnail ? <img src={convertFileSrc(thumbnail)} alt="会话产物" draggable={false} /> : <ImageIcon size={18} aria-label={products.length ? "产物暂不可用" : "暂无产物"} />}
            {products.length > 1 && <span className="workflow-history-image-count">{products.length} 张</span>}
          </span>
          <span className="workflow-history-summary">
            <span className="workflow-history-title">{saved.text?.trim() || `生成会话 ${rows.length - index}`}</span>
            <small><time dateTime={created.toISOString()}>{created.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time><span>{status}</span></small>
          </span>
        </button></li>;
      })}</ul>}
      <BoardChipPreview hostRef={popup} extraAssets={assets} clickToFocus={false} zIndex={100000} />
    </div>, document.body)}
  </>;
}
