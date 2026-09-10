import { useEffect, useRef } from "react";
import { Check, X } from "lucide-react";
import { useStore } from "../store";
import { notifyError, notifySuccess } from "../lib/notify";

export function CollectionAddMode() {
  const targetId = useStore((s) => s.collectionAddTargetId);
  const target = useStore((s) => s.folders.find((folder) => folder.id === targetId));
  const count = useStore((s) => s.selectedIds.size);
  const busy = useStore((s) => s.collectionAddBusy);
  const mode = useStore((s) => s.mode);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const exitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!targetId) return;
    exitRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      useStore.getState().cancelCollectionAdd();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [targetId]);

  useEffect(() => {
    if (targetId && !busy && (!target || mode !== "manage" || activeProjectId)) {
      useStore.getState().cancelCollectionAdd();
    }
  }, [targetId, target, busy, mode, activeProjectId]);

  if (!targetId || !target) return null;
  async function finish() {
    try {
      const added = await useStore.getState().finishCollectionAdd();
      if (added) notifySuccess(`已添加 ${added} 张素材到集合`);
    } catch (error) {
      notifyError(error, "添加失败，已保留选择，请重试");
    }
  }

  return <>
    <div className="collection-add-frame" aria-hidden="true" />
    <div className="collection-add-controls" role="region" aria-label="添加素材模式">
      <div className="collection-add-notch">
        <span className="collection-add-target" title={`添加素材中-目标集合：${target.name}`}>添加素材中-目标集合：{target.name}</span>
        <span className="collection-add-count" aria-live="polite">已选 {count} 张</span>
      </div>
      <div className="collection-add-actions">
        <button type="button" disabled={busy || count === 0} onClick={() => void finish()}>
          <Check size={14} />{busy ? "正在添加…" : "完成添加"}
        </button>
        <button ref={exitRef} type="button" disabled={busy} title="或者按esc退出"
          onClick={() => useStore.getState().cancelCollectionAdd()}><X size={14} />退出添加</button>
      </div>
    </div>
  </>;
}
