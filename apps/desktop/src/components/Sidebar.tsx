import { useMemo } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";

/** 左侧栏：素材统计 + 文件夹/智能文件夹 + 颜色筛选。 */
export function Sidebar() {
  const total = useStore((s) => s.total);
  const assets = useStore((s) => s.assets);
  const selectedCount = useStore((s) => s.selectedIds.size);
  const currentFolderId = useStore((s) => s.currentFolderId);
  const setCurrentFolder = useStore((s) => s.setCurrentFolder);
  const colorFilter = useStore((s) => s.colorFilter);
  const setColorFilter = useStore((s) => s.setColorFilter);
  const folders = useStore((s) => s.folders);

  // 全库 top-12 主色（聚合 assets.colors）。
  const topColors = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of assets) {
      try {
        const cs = a.colors ? (JSON.parse(a.colors) as unknown) : [];
        if (Array.isArray(cs)) {
          for (const c of cs) {
            if (typeof c === "string") counts.set(c, (counts.get(c) ?? 0) + 1);
          }
        }
      } catch {
        /* ignore */
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([c]) => c);
  }, [assets]);

  async function addSmartFolder() {
    const name = window.prompt("智能文件夹名称（如：扩展采集）");
    if (!name) return;
    const kind = window.prompt("按什么过滤？输入 source 或 ext", "source");
    if (kind !== "source" && kind !== "ext") return;
    const val = window.prompt(`${kind} 的值？例如 source 用 extension，ext 用 png`, kind === "source" ? "extension" : "png");
    if (!val) return;
    await api.createSmartFolder(name, `${kind}:${val}`);
    await useStore.getState().reloadFolders();
  }

  return (
    <aside className="w-56 shrink-0 overflow-y-auto border-r border-edge bg-panel p-3 text-sm">
      <div className="mb-4">
        <div className="text-xs uppercase tracking-wide text-muted">素材总数</div>
        <div className="text-2xl font-semibold">{total}</div>
      </div>

      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-muted">
        <span>文件夹</span>
        <button
          onClick={addSmartFolder}
          className="rounded text-accent hover:opacity-80"
          title="创建智能文件夹"
        >
          + 智能
        </button>
      </div>
      <div className="space-y-1">
        <div
          className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 ${
            currentFolderId === null ? "bg-panel2" : "hover:bg-panel2"
          }`}
          onClick={() => setCurrentFolder(null)}
        >
          📚 全部
        </div>
        {folders
          .filter((f) => f.id !== "root")
          .map((f) => (
            <div
              key={f.id}
              className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 ${
                currentFolderId === f.id ? "bg-panel2" : "hover:bg-panel2"
              }`}
              onClick={() => setCurrentFolder(f.id)}
              title={f.smart_query ?? ""}
            >
              {f.kind === "smart" ? "🔍" : "📁"} {f.name}
            </div>
          ))}
      </div>

      {topColors.length > 0 && (
        <>
          <div className="mb-2 mt-4 flex items-center justify-between text-xs uppercase tracking-wide text-muted">
            <span>颜色</span>
            {colorFilter && (
              <button
                onClick={() => setColorFilter(null)}
                className="text-accent hover:opacity-80"
              >
                清除
              </button>
            )}
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {topColors.map((c) => (
              <button
                key={c}
                onClick={() => setColorFilter(colorFilter === c ? null : c)}
                className={`aspect-square rounded ring-offset-2 ring-offset-panel ${
                  colorFilter === c ? "ring-2 ring-accent" : ""
                }`}
                style={{ background: c }}
                title={c}
              />
            ))}
          </div>
        </>
      )}

      {selectedCount > 0 && (
        <>
          <div className="mb-2 mt-4 text-xs uppercase tracking-wide text-muted">已选</div>
          <div className="text-accent">{selectedCount} 张</div>
          <div className="mt-1 text-xs text-muted">批量模式 · 点击切换选中</div>
        </>
      )}
    </aside>
  );
}
