import { useStore } from "../store";
import { api } from "../lib/api";
import { CodexStatus } from "./CodexStatus";

/** 顶部工具栏：导入 + 搜索 + 批量管理 + 创作板入口。 */
export function Toolbar({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const setLoading = useStore((s) => s.setLoading);
  const busy = useStore((s) => s.loading);
  const mode = useStore((s) => s.mode);
  const enterManage = useStore((s) => s.enterManage);
  const boardOpen = useStore((s) => s.boardOpen);
  const toggleBoard = useStore((s) => s.toggleBoard);
  const searchQuery = useStore((s) => s.searchQuery);
  const setSearchQuery = useStore((s) => s.setSearchQuery);
  const classifyProgress = useStore((s) => s.classifyProgress);

  async function withBusy(fn: () => Promise<unknown>) {
    setLoading(true);
    try {
      await fn();
      await onRefresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2 border-b border-edge bg-panel px-3 py-2">
      <button
        onClick={() =>
          withBusy(async () => {
            const paths = await api.pickImageFiles();
            if (paths.length) await api.importFiles(paths);
          })
        }
        disabled={busy}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50"
      >
        导入文件
      </button>
      <button
        onClick={() =>
          withBusy(async () => {
            const p = await api.pickFolder();
            if (p) await api.importFolder(p);
          })
        }
        disabled={busy}
        className="rounded-md bg-panel2 px-3 py-1.5 text-sm text-ink hover:bg-edge disabled:opacity-50"
      >
        导入文件夹
      </button>
      <button
        onClick={() => enterManage()}
        disabled={busy || mode === "manage"}
        className="rounded-md bg-panel2 px-3 py-1.5 text-sm text-ink hover:bg-edge disabled:opacity-50"
      >
        批量管理
      </button>
      <button
        onClick={() => void api.reclassifyAll()}
        disabled={busy || !!classifyProgress}
        className="rounded-md bg-panel2 px-3 py-1.5 text-sm text-ink hover:bg-edge disabled:opacity-50"
        title="对所有「无类别且已反推」的图，按描述重新自动归类（后台跑，仅归类不改名/描述）"
      >
        智能归类全部
      </button>
      {classifyProgress && (
        <span className="text-xs tabular-nums text-muted">
          归类中 {classifyProgress.done}/{classifyProgress.total}
        </span>
      )}
      <input
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="搜索文件名…"
        className="ml-2 w-64 rounded-md bg-panel2 px-3 py-1.5 text-sm outline-none ring-1 ring-edge focus:ring-accent"
      />
      {searchQuery && (
        <button
          onClick={() => setSearchQuery("")}
          className="text-xs text-muted hover:text-ink"
        >
          清除
        </button>
      )}
      <div className="ml-auto flex items-center gap-2">
        <span className="text-xs text-muted">{busy ? "处理中…" : ""}</span>
        <button
          onClick={toggleBoard}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            boardOpen
              ? "bg-accent text-black hover:opacity-90"
              : "bg-panel2 text-ink hover:bg-edge"
          }`}
          title="打开创作板（核心枢纽）"
        >
          🎬 创作板
        </button>
        <CodexStatus />
      </div>
    </div>
  );
}
