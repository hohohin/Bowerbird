import { setTheme } from "@tauri-apps/api/app";
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
    return isAppTheme(cached) ? cached : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: AppTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  // WebView 原生控件（select 弹层、滚动条等）跟随 Tauri 应用主题，而不只看页面 CSS。
  if (isTauri()) {
    void setTheme(theme).catch((error) => console.error("set app theme failed", error));
  }
  try {
    localStorage.setItem(THEME_CACHE_KEY, theme);
  } catch {
    // settings.json 才是权威持久化源；localStorage 仅用于首帧缓存。
  }
}
