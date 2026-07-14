import { useState, type ReactNode } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";

/** 空素材库的首次任务引导：核心流程先于 AI 配置出现。 */
export function WelcomePanel() {
  const setLoading = useStore((s) => s.setLoading);
  const [message, setMessage] = useState("");

  async function importFiles() {
    setLoading(true);
    try {
      const paths = await api.pickImageFiles();
      if (paths.length) {
        const assets = await api.importFiles(paths);
        setMessage(`已导入 ${assets.length} 张素材；可继续浏览，AI 分析将在后台完成。`);
      }
    } finally { setLoading(false); }
  }

  async function importFolder() {
    setLoading(true);
    try {
      const path = await api.pickFolder();
      if (path) {
        const count = await api.importFolder(path);
        setMessage(`已导入 ${count} 张素材；可继续浏览，AI 分析将在后台完成。`);
      }
    } finally { setLoading(false); }
  }

  return <div className="flex h-full items-center justify-center overflow-auto p-8">
    <div className="w-full max-w-3xl">
      <div className="mb-7 text-center"><h1 className="text-2xl font-semibold text-ink">从第一张灵感图开始</h1><p className="mt-2 text-sm text-muted">Bowerbird 可以先作为本地素材库使用；Codex 与浏览器扩展是可选增强。</p></div>
      <div className="grid gap-3 md:grid-cols-3">
        <TaskCard number="1" title="导入本地素材" text="导入文件或整个文件夹，马上开始整理、搜索与收藏。" action="选择文件" onClick={() => void importFiles()} extra={<button onClick={() => void importFolder()} className="mt-2 text-xs text-muted hover:text-ink">或导入文件夹</button>} />
        <TaskCard number="2" title="安装浏览器采集" text="在 Chrome 或 Edge 加载 Windows/extension，网页右下角会出现采集按钮。" action="查看说明" onClick={() => setMessage("请打开 Windows/extension/README.md，按其中步骤加载浏览器扩展。")} />
        <TaskCard number="3" title="配置 Codex AI" text="启用自动命名、图片反推与创作板生成。未配置也不影响本地素材管理。" action="打开环境状态" onClick={() => setMessage("点击顶部“环境状态”可查看 Codex 配置与扩展连接情况。")} />
      </div>
      {message && <div className="mt-5 rounded-md border border-edge bg-panel p-3 text-center text-sm text-muted">{message}</div>}
    </div>
  </div>;
}

function TaskCard({ number, title, text, action, onClick, extra }: { number: string; title: string; text: string; action: string; onClick: () => void; extra?: ReactNode }) {
  return <section className="rounded-lg border border-edge bg-panel p-5"><div className="mb-4 flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">{number}</div><h2 className="font-medium text-ink">{title}</h2><p className="mt-2 min-h-12 text-sm leading-relaxed text-muted">{text}</p><button onClick={onClick} className="mt-4 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:opacity-90">{action}</button>{extra}</section>;
}
