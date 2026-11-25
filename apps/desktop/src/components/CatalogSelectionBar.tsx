import type { ReactNode } from "react";
import { Tags, X } from "lucide-react";

export function CatalogSelectionBar({ count, busy, projectId, onFinish, onSelectAll, onAssign, onMove, onTags, onAdd, children }: {
  count: number; busy: boolean; projectId: string | null; onFinish: () => void;
  onSelectAll: () => void; onAssign: () => void; onMove: () => void; onTags: (trigger: HTMLButtonElement) => void; onAdd?: () => void; children?: ReactNode;
}) {
  return <div className="catalog-selection" role="group" aria-label="分类素材所选操作">
    <button aria-label="取消选择" disabled={busy} onClick={onFinish}><X size={14}/></button>
    <span>{busy ? "正在处理…" : `${count} 项`}</span><button disabled={busy} onClick={onSelectAll}>全选</button>
    <button type="button" className="inline-flex items-center gap-1" disabled={busy || !count} onClick={event => onTags(event.currentTarget)}><Tags size={14} aria-hidden="true" />标签</button>
    <button disabled={busy || !count} onClick={onAssign}>添加到文件夹</button>
    <button disabled={busy || !count} onClick={onMove}>移动到文件夹</button>
    {children}
    {onAdd && <button disabled={busy || !count} onClick={onAdd}>{projectId ? "添加到画板" : "添加到新项目"}</button>}
  </div>;
}
