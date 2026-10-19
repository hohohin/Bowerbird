import { X } from "lucide-react";

export function LibraryTagFilter({ name, onClear }: { name: string; onClear: () => void }) {
  return <div className="library-tag-filter" role="group" aria-label={`当前标签：${name}`}>
    <span title={name}>{name}</span>
    <button type="button" aria-label={`清除标签筛选：${name}`} title="清除标签筛选" onClick={onClear}>
      <X size={12} aria-hidden="true" />
    </button>
  </div>;
}
