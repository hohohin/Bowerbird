import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MasonryGrid } from "../../../src/components/MasonryGrid";
import { MediaPreview } from "../../../src/components/MediaPreview";
import { Lightbox } from "../../../src/components/Lightbox";
import { VideoPoster } from "../../../src/components/VideoPoster";
import { useStore } from "../../../src/store";
import { prepareGenerationSound } from "../../../src/lib/generationNotifications";
import "../../../src/styles.css";

const w = window as any;
w.__TAURI_INTERNALS__ = { convertFileSrc: (path: string) => path, invoke: async () => ({}) };
const root = createRoot(document.getElementById("root")!);
const poster = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='90'%3E%3Crect width='160' height='90' fill='green'/%3E%3C/svg%3E";
const calls: string[] = [];
let active = 0, maxActive = 0;
w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
  if (command !== "video_poster") return {};
  calls.push(args.sourcePath);
  active++;
  maxActive = Math.max(active, maxActive);
  await new Promise(resolve => setTimeout(resolve, 30));
  active--;
  if (args.sourcePath === "/never-load-4.mp4") throw new Error("unsupported codec");
  return args.sourcePath === "/never-load-2.mp4" ? null : poster;
};
const assets = Array.from({ length: 12 }, (_, i) => ({ id: `clip-${i}`, name: `视频 ${i}`, ext: "mp4", width: 160, height: 90,
  store_path: `/never-load-${i}.mp4`, thumb_path: i % 2 ? poster : null, duration: 5, source: "imported" }));
useStore.setState({ assets: assets as any, total: assets.length, boardOpen: false, activeProjectId: "test", settings: {} as any });
let opened = "";
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (condition()) return; await tick(); }
  const img = document.querySelector<HTMLImageElement>('[data-asset-id="clip-0"] img');
  throw new Error(`poster did not settle: ${JSON.stringify({ phase: w.mediaSmokePhase, src: img?.src, width: img?.naturalWidth, rect: img?.getBoundingClientRect(), visibility: document.visibilityState })}`);
}

w.runMediaPreviewSmoke = async () => {
  const cleanup = prepareGenerationSound(true);
  try {
    // Exercise the same audio initialization alongside project media mounting in native WebKit.
    window.dispatchEvent(new Event("pointerdown"));
    for (let round = 0; round < 30; round++) {
      w.mediaSmokePhase = `round ${round}`;
      flushSync(() => root.render(<React.Fragment key={round}>
        <MasonryGrid variant={round % 2 ? "library" : "canvas-source"} assetsOverride={assets as any} totalOverride={assets.length}
          onOpenPreview={asset => { opened = asset.store_path!; }} />
        <button id="result" onClick={() => { opened = assets[0].store_path; }}>
          <MediaPreview src={assets[0].store_path} videoPath={assets[0].store_path} alt="生成结果" />
        </button>
      </React.Fragment>));
      await tick();
      await until(() => document.querySelector<HTMLImageElement>("#result img")?.getAttribute("src") === poster);
      await until(() => (document.querySelector<HTMLImageElement>('[data-asset-id="clip-0"] img')?.naturalWidth ?? 0) > 0);
      check(document.querySelectorAll("[data-asset-id]").length === 12, "video source cards must remain interactive");
      check(document.querySelectorAll("video").length === 0, "opening a project mounted a video player");
      (document.querySelector('[data-asset-id="clip-0"]') as HTMLElement).click();
      check(opened === assets[0].store_path, "missing-poster video did not open its original");
      opened = "";
      document.getElementById("result")!.click();
      check(opened === assets[0].store_path, "video result preview swallowed the parent click");
      flushSync(() => root.render(null));
      await tick();
    }
    await until(() => calls.length === 6 && active === 0);
    check(new Set(calls).size === calls.length && maxActive === 1, "poster requests duplicated or decoded concurrently");
    // A previous asynchronous result must not become the next video's cover.
    flushSync(() => root.render(<VideoPoster path="/never-load-stale.mp4" alt="stale" />));
    flushSync(() => root.render(<VideoPoster path="/never-load-2.mp4" alt="failed" />));
    await until(() => calls.length === 7 && active === 0);
    await tick();
    check(document.querySelector("img")?.getAttribute("src") !== poster, "old cover leaked into a different video");
    check(!document.querySelector("video"), "failed extraction created a player");
    flushSync(() => root.render(null));
    // The deliberate playback UI retains the original URL, but does not load until play.
    for (let i = 0; i < 5; i++) {
      flushSync(() => root.render(<Lightbox images={[assets[0].store_path]} index={0}
        onClose={() => root.render(null)} onIndexChange={() => {}} />));
      const video = document.querySelector("video")!;
      check(video?.getAttribute("src") === assets[0].store_path && video.controls && video.preload === "none", "explicit playback contract");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await tick();
      check(!document.querySelector("video"), "closed player remained mounted");
    }
    check(!performance.getEntriesByType("resource").some(entry => /never-load-.*\.mp4/.test(entry.name)), "preview fetched video bytes before play");
    check(errors.length === 0, errors.join("; "));
    return "PASS: cached async static posters, serialized/deduplicated extraction, failed/stale results, 30 project/library mount cycles with audio, 5 explicit player open/close cycles, zero video preload requests";
  } finally { cleanup?.(); }
};
if (new URLSearchParams(location.search).has("native")) {
  w.runMediaPreviewSmoke().then((message: string) => w.webkit.messageHandlers.smoke.postMessage({ ok: true, message }))
    .catch((error: Error) => w.webkit.messageHandlers.smoke.postMessage({ ok: false, message: `${error.message}\n${error.stack || ""}` }));
}
