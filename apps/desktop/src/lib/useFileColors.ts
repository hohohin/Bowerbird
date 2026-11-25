import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LocalFileEntry } from "./externalFiles";

export const FILE_COLORS = [
  ["red", "红", "#D92424"], ["orange", "橙", "#E8722C"], ["yellow", "黄", "#E8C62A"],
  ["green", "绿", "#3DA535"], ["cyan", "青", "#1FB5C4"], ["blue", "蓝", "#2D5BD9"],
  ["purple", "紫", "#7B3FD9"], ["pink", "粉", "#E056B0"], ["brown", "棕", "#7A4A1E"],
  ["gray", "灰", "#8A8A8A"], ["white", "白", "#F2F2F2"], ["black", "黑", "#1A1A1A"],
] as const;

export function useFileColors(entries: LocalFileEntry[], enabled: boolean, revision: number) {
  const cache = useRef(new Map<string, { version: LocalFileEntry["version"]; keys: string[] }>());
  const [colors, setColors] = useState(new Map<string, string[]>());
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(0);
  const [retry, setRetry] = useState(0);
  // Searching/filtering and retrying must not discard successful reads. A directory
  // refresh starts a new snapshot; version checks also cover updated tag results.
  useEffect(() => { cache.current = new Map(); }, [revision]);
  useEffect(() => {
    const current = cache.current;
    const known = new Map<string, string[]>();
    const queue = entries.filter(entry => {
      if (entry.directory) return false;
      const cached = current.get(entry.path);
      if (!cached || cached.version !== entry.version) return true;
      known.set(entry.path, cached.keys);
      return false;
    });
    setColors(known);
    if (!enabled) { setPending(false); return; }
    let alive = true, index = 0;
    setPending(queue.length > 0); setFailed(0);
    async function worker() {
      while (alive && index < queue.length) {
        const entry = queue[index++];
        try {
          const keys = await invoke<string[]>("file_colors", { path: entry.path });
          if (!alive) return;
          current.set(entry.path, { version: entry.version, keys });
          known.set(entry.path, keys); setColors(new Map(known));
        } catch { if (alive) setFailed(value => value + 1); }
      }
    }
    void Promise.all([worker(), worker()]).then(() => { if (alive) setPending(false); });
    return () => { alive = false; };
  }, [entries, enabled, revision, retry]);
  return { colors, pending, failed, retry: () => setRetry(value => value + 1) };
}
