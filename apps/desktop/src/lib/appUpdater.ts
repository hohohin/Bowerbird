import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type Phase = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "installed";
interface AppUpdaterState {
  phase: Phase;
  update: Update | null;
  downloaded: number;
  total: number | null;
  error: string | null;
  startupChecked: boolean;
  startupPrompt: boolean;
  dismissStartupPrompt: () => void;
  check: (options?: { startup?: boolean }) => Promise<void>;
  download: () => Promise<void>;
  install: (beforeInstall: () => Promise<void>) => Promise<void>;
  restart: () => Promise<void>;
}

// Keep the resource and progress across closing/reopening Settings. Nothing is
// persisted: after an app restart the release must be checked and verified again.
export const useAppUpdater = create<AppUpdaterState>((set, get) => ({
  phase: "idle", update: null, downloaded: 0, total: null, error: null,
  startupChecked: false, startupPrompt: false,
  dismissStartupPrompt: () => set({ startupPrompt: false }),
  check: async ({ startup = false } = {}) => {
    // Session-only guard also covers StrictMode and component remounts.
    if (startup) {
      if (get().startupChecked) return;
      set({ startupChecked: true });
    }
    if (!["idle", "current", "available"].includes(get().phase)) return;
    const previous = get().update;
    set({ phase: "checking", error: null });
    try {
      const update = await check({ timeout: 30_000 });
      set({ update, phase: update ? "available" : "current", downloaded: 0, total: null,
        startupPrompt: startup && update !== null });
      await previous?.close().catch(() => {});
    } catch (error) {
      set({ phase: previous ? "available" : "idle", error: startup ? null : `检查更新失败：${String(error)}` });
    }
  },
  download: async () => {
    const { update, phase } = get();
    if (!update || phase !== "available") return;
    set({ phase: "downloading", error: null, downloaded: 0, total: null });
    try {
      await update.download((event) => {
        if (event.event === "Started") set({ total: event.data.contentLength ?? null });
        if (event.event === "Progress") set((s) => ({ downloaded: s.downloaded + event.data.chunkLength }));
      }, { timeout: 300_000 });
      // Finished only means the network stream ended. download() must resolve
      // (including signature verification) before enabling installation.
      set({ phase: "ready" });
    } catch (error) {
      set({ phase: "available", error: `下载或校验失败：${String(error)}` });
    }
  },
  install: async (beforeInstall) => {
    const { update, phase } = get();
    if (!update || phase !== "ready") return;
    set({ phase: "installing", error: null });
    try {
      await beforeInstall();
      // Windows starts the passive NSIS installer and exits here; the installer
      // relaunches the app. Other desktop platforms return and need relaunch().
      await update.install();
    } catch (error) {
      set({ phase: "ready", error: `安装未完成：${String(error)}` });
      return;
    }
    set({ phase: "installed" });
    await get().restart();
  },
  restart: async () => {
    if (get().phase !== "installed") return;
    set({ error: null });
    try { await relaunch(); }
    catch (error) { set({ error: `更新已安装，请关闭并重新打开应用：${String(error)}` }); }
  },
}));
