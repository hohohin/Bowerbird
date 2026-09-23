import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { existingWorkflowCaption } from "../lib/workflowDescribe";

export function WorkflowDescribeOption({ assetIds, checked, disabled, onChange }: {
  assetIds: string[]; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [rows, setRows] = useState<Array<{ id: string; name: string; text: string }> | null>(null);
  const [error, setError] = useState("");
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const key = JSON.stringify([...new Set(assetIds)]);
  const keep = () => clearTimeout(closeTimer.current);
  const close = () => { keep(); closeTimer.current = setTimeout(() => setAnchor(null), 120); };
  useEffect(() => () => keep(), []);
  useEffect(() => {
    if (!anchor) return;
    let alive = true; setRows(null); setError("");
    const ids: string[] = JSON.parse(key);
    void Promise.all([api.getAssetsByIds(ids), Promise.all(ids.map(existingWorkflowCaption))]).then(([assets, captions]) => {
      if (alive) setRows(ids.map((id, index) => ({ id, name: assets.find(asset => asset.id === id)?.name ?? `图片 ${index + 1}`,
        text: captions[index].map(part => `${part.title}：${part.body}`).join("\n\n") })));
    }).catch(error => { if (alive) setError(`读取反推数据失败：${String(error)}`); });
    return () => { alive = false; };
  }, [anchor, key]);
  return <div className="workflow-describe-option" onPointerDown={event => event.stopPropagation()}>
    <label><input type="checkbox" aria-label="覆盖已有反推" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />覆盖</label>
    <button type="button" className="workflow-existing-caption" aria-label="查看已有反推" aria-expanded={!!anchor}
      onMouseEnter={event => { keep(); const rect = event.currentTarget.getBoundingClientRect(); setAnchor({ x: rect.left, y: rect.bottom }); }}
      onFocus={event => { keep(); const rect = event.currentTarget.getBoundingClientRect(); setAnchor({ x: rect.left, y: rect.bottom }); }}
      onMouseLeave={close} onBlur={close} onKeyDown={event => { if (event.key === "Escape") setAnchor(null); }}>已有反推</button>
    {anchor && createPortal(<div className="workflow-caption-preview" role="tooltip" aria-label="已有反推数据"
      style={{ left: Math.max(8, Math.min(anchor.x, window.innerWidth - 368)), top: Math.max(8, Math.min(anchor.y + 6, window.innerHeight - 330)) }}
      onMouseEnter={keep} onMouseLeave={close} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <strong>已有反推</strong>{error ? <p>{error}</p> : rows === null ? <p>正在读取…</p> : !rows.length ? <p>尚未收到图片，请先连接图片或运行上游</p>
        : rows.map(row => <section key={row.id}><b>{row.name}</b><p>{row.text || "暂无反推数据"}</p></section>)}
    </div>, document.body)}
  </div>;
}
