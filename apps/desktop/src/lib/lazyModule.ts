import { lazy, type ComponentType } from "react";

const reloadKey = "bowerbird.chunk-reload";

/**
 * A lazy chunk can fail once while Vite re-optimizes dependencies or right after an
 * update replaces the built assets. Reload once to recover; a repeated failure is a
 * real error and must reach the error boundary instead of blanking the window.
 */
export function lazyModule<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const module = await load();
      sessionStorage.removeItem(reloadKey);
      return module;
    } catch (error) {
      if (sessionStorage.getItem(reloadKey)) throw error;
      sessionStorage.setItem(reloadKey, "1");
      location.reload();
      await new Promise<never>(() => {});
      throw error;
    }
  });
}
