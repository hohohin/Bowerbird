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
  const currentProjectId = useStore((s) => s.currentProjectId);
  const setSearchQuery = useStore((s) => s.setSearchQuery);
  const collectedNotice = useStore((s) => s.collectedNotice);
  const setCollectedNotice = useStore((s) => s.setCollectedNotice);
  const setCurrentFolder = useStore((s) => s.setCurrentFolder);
  const setCurrentCollection = useStore((s) => s.setCurrentCollection);
  const setSmartFilter = useStore((s) => s.setSmartFilter);
  const setColorFilter = useStore((s) => s.setColorFilter);
  const tourActive = useStore((s) => s.tourActive);
  const tourStep = useStore((s) => s.tourStep);
  const setTourStep = useStore((s) => s.setTourStep);
  const enterProject = useStore((s) => s.enterProject);
  const reloadProjects = useStore((s) => s.reloadProjects);

  // 扩展采集入根库；清空当前范围让用户立刻看见新素材。
  function showCollectedAsset() {
    setCurrentCollection(null);
    setCurrentFolder(null);
    setSearchQuery("");
    setSmartFilter(null);
    setColorFilter(null);
    setCollectedNotice(null);
  }

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
            if (paths.length) await api.importFiles(paths, currentProjectId);
          })
        }
        disabled={busy}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50"
      >
        导入文件
      </button>
      <button
        data-tour="import-folder"
        onClick={() =>
          withBusy(async () => {
            // tour 第 1 步：真实体验导入，但走建项目流程 + 默认定位到预设图目录。
            if (tourActive && tourStep === 1) {
              const presetDir = await api.releasePresetPack();
              const p = await api.pickFolder(presetDir);
              if (!p) return;
              const result = await api.createProject(p);
              await reloadProjects();
              await enterProject(result.project.id);
              setTourStep(2);
              return;
            }
            const p = await api.pickFolder();
            if (p) await api.importFolder(p, currentProjectId);
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
        {collectedNotice && (
          <button
            onClick={showCollectedAsset}
            className="max-w-48 truncate rounded-md bg-green-500/15 px-2.5 py-1.5 text-xs text-green-300 hover:bg-green-500/25"
            title={`已采集：${collectedNotice}。点击回到总库查看。`}
          >
            已采集：{collectedNotice} · 查看
          </button>
        )}
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
