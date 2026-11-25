import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { ImageOff } from "lucide-react";

export function shotFrameLoader(assetId: string, sourceHash: string) {
  const cached = new Map<number, string>();
  const pending = new Map<number, Set<(path: string | null) => void>>();
  let running = false;
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.size) {
        const startMs = pending.keys().next().value!;
        let url: string | null = null;
        try {
          const path = await invoke<string>("video_shots_frame", { assetId, sourceHash, startMs });
          url = convertFileSrc(path);
          cached.set(startMs, url);
        } catch { /* Keep a visible placeholder when this frame cannot be decoded. */ }
        pending.get(startMs)?.forEach(fn => fn(url));
        pending.delete(startMs);
      }
    } finally { running = false; }
  }
  return (startMs: number, receive: (path: string | null) => void) => {
    const url = cached.get(startMs);
    if (url) { receive(url); return () => {}; }
    const listeners = pending.get(startMs) ?? new Set();
    listeners.add(receive);
    pending.set(startMs, listeners);
    void drain();
    return () => { listeners.delete(receive); if (!listeners.size) pending.delete(startMs); };
  };
}

export function ShotFrame({ load, start, label = "" }: { load: ReturnType<typeof shotFrameLoader>; start: number; label?: string }) {
  const host = useRef<HTMLSpanElement>(null);
  const [url,setUrl] = useState<string | null>();
  useEffect(() => {
    setUrl(undefined);
    const el = host.current;
    if (!el) return;
    let release: (() => void) | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !release) release = load(start, setUrl);
      else if (!entry.isIntersecting && release) { release(); release = undefined; }
    });
    observer.observe(el);
    return () => { observer.disconnect(); release?.(); };
  }, [start,load]);
  return <span ref={host} className="shot-frame" role={label ? "img" : undefined} aria-label={label || undefined}>
    {url ? <img src={url} alt=""/> : url === null ? <ImageOff size={16} aria-hidden="true"/> : null}
  </span>;
}
