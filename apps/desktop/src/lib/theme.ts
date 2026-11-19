import { setTheme } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri } from "@tauri-apps/api/core";
import type { AppTheme } from "./types";

const THEME_CACHE_KEY = "bowerbird.theme";

function isAppTheme(value: unknown): value is AppTheme {
  return value === "light" || value === "dark";
}

/**
 * 启动首帧使用的本地缓存。settings.json 载入后仍会用后端值覆盖，
 * 这里仅避免已选择日间模式的用户每次启动先闪一下夜间界面。
 */
export function loadCachedTheme(): AppTheme {
  try {
    const cached = localStorage.getItem(THEME_CACHE_KEY);
    return isAppTheme(cached) ? cached : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: AppTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  // macos-titlebar grants the native theme command to the Mac main webview.
  if (isTauri() && /Mac/i.test(navigator.platform) && getCurrentWebview().label === "main") {
    void setTheme(theme).catch((error) => console.error("set app theme failed", error));
  }
  try {
    localStorage.setItem(THEME_CACHE_KEY, theme);
  } catch {
    // settings.json 才是权威持久化源；localStorage 仅用于首帧缓存。
  }
}
