import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";

/**
 * 设置面板（全屏 Modal，约定 13 形态：fixed inset-0 z-50 + bg-black/60 遮罩）。
 *
 * 集中三类「整库级」运维操作，从顶栏收纳进来：
 * - 环境状态：codex CLI 可用性（就绪/未就绪 + reason），可重新检测。复用 store.codexHealth。
 * - 重建色板：重新量化全库主色到颜色桶（存量图补色板）。进度走全局 store.colorRebuild。
 * - 智能归类全部：对「无类别且已反推」的图按描述重新自动归类。进度走全局 store.classifyProgress。
 *
 * 可见性由调用方控制（open）；false 时 return null。
 */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const codexHealth = useStore((s) => s.codexHealth);
  const setCodexHealth = useStore((s) => s.setCodexHealth);
  const extensionConnected = useStore((s) => s.extensionConnected);
  const classifyProgress = useStore((s) => s.classifyProgress);
  const colorRebuild = useStore((s) => s.colorRebuild);

  const [checking, setChecking] = useState(false);

  // 打开时刷新一次 codex 状态（看到的是当前环境，而非 App 挂载时的快照）。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setChecking(true);
    api
      .codexHealth()
      .then((h) => {
        if (alive) setCodexHealth(h);
      })
      .catch(() => {
        if (alive) setCodexHealth({ ok: false, reason: "codex 状态检测失败" });
      })
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, [open, setCodexHealth]);

  if (!open) return null;

  async function recheck() {
    setChecking(true);
    try {
      setCodexHealth(await api.codexHealth());
    } catch {
      setCodexHealth({ ok: false, reason: "codex 状态检测失败" });
    } finally {
      setChecking(false);
    }
  }

  async function reclassifyAll() {
    try {
      await api.reclassifyAll();
    } catch (e) {
      console.error("reclassifyAll failed", e);
    }
  }

  async function recomputeColors() {
    try {
      await api.recomputeColors();
    } catch (e) {
      console.error("recomputeColors failed", e);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-edge bg-panel p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">设置</h2>
          <button
            onClick={onClose}
            className="rounded-md bg-panel2 px-2 py-1 text-sm text-muted hover:text-ink"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {/* 环境状态 */}
        <section className="mt-5">
          <h3 className="text-sm font-medium text-ink">环境状态</h3>
          <p className="mt-1 text-xs text-muted">
            反推、生成图、采集即命名都依赖 codex CLI（走 ChatGPT 订阅）。不配置也能正常使用本地素材库。
          </p>
          <div className="mt-2 flex items-center gap-2">
            <div
              className={`rounded px-2 py-1 text-xs ${
                codexHealth?.ok
                  ? "bg-accent/15 text-accent"
                  : "bg-red-500/15 text-red-300"
              }`}
            >
              {checking
                ? "检测中…"
                : codexHealth?.ok
                  ? "codex 就绪"
                  : codexHealth?.reason || "codex 不可用"}
            </div>
            <button
              onClick={() => void recheck()}
              disabled={checking}
              className="rounded-md bg-panel2 px-3 py-1 text-xs text-ink hover:bg-edge disabled:opacity-50"
            >
              重新检测
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <div
              className={`rounded px-2 py-1 text-xs ${
                extensionConnected ? "bg-accent/15 text-accent" : "bg-amber-500/15 text-amber-300"
              }`}
            >
              {extensionConnected ? "浏览器扩展已连接" : "浏览器扩展未连接"}
            </div>
            <span className="text-xs text-muted">
              {extensionConnected ? "本机采集服务在线" : "打开网页后等待扩展心跳"}
            </span>
          </div>
        </section>

        {/* 重建色板 */}
        <section className="mt-5">
          <h3 className="text-sm font-medium text-ink">重建色板</h3>
          <p className="mt-1 text-xs text-muted">
            重新量化全库主色到颜色桶（存量图补上色板）。后台跑，完成后侧栏色板自动刷新。
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => void recomputeColors()}
              disabled={!!colorRebuild}
              className="rounded-md bg-panel2 px-3 py-1.5 text-sm text-ink hover:bg-edge disabled:opacity-50"
            >
              重建色板
            </button>
            {colorRebuild && (
              <span className="text-xs tabular-nums text-muted">
                重建中 {colorRebuild.done}/{colorRebuild.total}
              </span>
            )}
          </div>
        </section>

        {/* 智能归类全部 */}
        <section className="mt-5">
          <h3 className="text-sm font-medium text-ink">智能归类全部</h3>
          <p className="mt-1 text-xs text-muted">
            对所有「无类别且已反推」的图，按描述重新自动归类（后台跑，仅归类不改名/描述）。
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => void reclassifyAll()}
              disabled={!!classifyProgress}
              className="rounded-md bg-panel2 px-3 py-1.5 text-sm text-ink hover:bg-edge disabled:opacity-50"
            >
              智能归类全部
            </button>
            {classifyProgress && (
              <span className="text-xs tabular-nums text-muted">
                归类中 {classifyProgress.done}/{classifyProgress.total}
              </span>
            )}
          </div>
        </section>

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-black hover:opacity-90"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
