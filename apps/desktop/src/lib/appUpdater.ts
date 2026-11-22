import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { userErrorMessage } from "./userError";

type Phase = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "installed";
interface AppUpdaterState {
  phase: Phase;
  update: Update | null;
  downloaded: number;
  total: number | null;
  error: string | null;
  startupChecked: boolean;
  check: (options?: { startup?: boolean; background?: boolean }) => Promise<void>;
  download: () => Promise<void>;
  install: (beforeInstall: () => Promise<void>) => Promise<void>;
  restart: () => Promise<void>;
}

let backgroundChecking = false;

export function updateDownloadPercent({ downloaded, total }: Pick<AppUpdaterState, "downloaded" | "total">) {
  return total && total > 0 ? Math.min(100, Math.floor(downloaded / total * 100)) : null;
}

// Keep the resource and progress across closing/reopening Settings. Nothing is
// persisted: after an app restart the release must be checked and verified again.
export const useAppUpdater = create<AppUpdaterState>((set, get) => ({
  phase: "idle", update: null, downloaded: 0, total: null, error: null,
  startupChecked: false,
  check: async ({ startup = false, background = false } = {}) => {
    // Session-only guard also covers StrictMode and component remounts.
    if (startup) {
      if (get().startupChecked) return;
      set({ startupChecked: true });
    }
    const before = get();
    if (!["idle", "current", "available"].includes(before.phase)) return;
    if (background) {
      if (backgroundChecking) return;
      backgroundChecking = true;
    } else {
      set({ phase: "checking", error: null });
    }
    try {
      const update = await check({ timeout: 30_000 });
      // Keep the visible result during polling, and leave concurrent user actions in control.
      if (background && (
        get() !== before ||
        (update ? update.version === before.update?.version : before.phase === "current")
      )) {
        await update?.close().catch(() => {});
        return;
      }
      set({ update, phase: update ? "available" : "current", downloaded: 0, total: null, error: null });
      if (update) void get().download();
      await before.update?.close().catch(() => {});
    } catch (error) {
      console.warn("[updater] check failed", error);
      if (!background) {
        set({ phase: before.update ? "available" : before.phase,
          error: startup ? null : userErrorMessage(error, "暂时无法检查更新，请稍后再试。") });
      }
    } finally {
      if (background) backgroundChecking = false;
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
      console.warn("[updater] download or verification failed", error);
      set({ phase: "available", error: userErrorMessage(error, "更新包下载或验证未完成，请重新下载。") });
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
      console.warn("[updater] install failed", error);
      set({ phase: "ready", error: userErrorMessage(error, "更新尚未安装，请检查当前任务和保存状态后重试。") });
      return;
    }
    set({ phase: "installed" });
    await get().restart();
  },
  restart: async () => {
    if (get().phase !== "installed") return;
    set({ error: null });
    try { await relaunch(); }
    catch (error) {
      console.warn("[updater] restart failed", error);
      set({ error: "更新已安装，请关闭并重新打开应用。" });
    }
  },
}));
