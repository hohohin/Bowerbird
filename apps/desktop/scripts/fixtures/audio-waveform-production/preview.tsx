import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AudioWaveform } from "../../../src/components/AudioWaveform";
import { stopAudioPreview } from "../../../src/lib/audioPreview";
import "../../../src/components/LibraryTactical.css";
import "../../../src/components/IndustrialTheme.css";

type Item = { assetId: string; instance?: string; path?: string; version?: string; expectedVersion?: string; top?: number; interactive?: boolean };
const test = window as unknown as {
  __TAURI_INTERNALS__: { convertFileSrc(path: string): string; invoke(command: string, args: { assetId: string; expectedVersion?: string }): Promise<unknown> };
  waveformCalls: { assetId: string; expectedVersion?: string }[]; peakActive: number; peakMaximum: number; holdPeaks: boolean;
  sourceVersions: Record<string, string>; waveformFailures: string[]; durationUpdates: Record<string, number>; resolvedDurations: Record<string, number>; parentClicks: number;
  setAudioFixtureItems(items: Item[]): void; releaseWaveforms(): void; stopAudioFixture(assetId?: string): void;
  stopAudioFolderFixture(path: string): Promise<void>;
};
let held: (() => void)[] = [];
test.waveformCalls = []; test.peakActive = 0; test.peakMaximum = 0; test.holdPeaks = false;
test.sourceVersions = {}; test.waveformFailures = []; test.durationUpdates = {}; test.resolvedDurations = {}; test.parentClicks = 0;
test.releaseWaveforms = () => { const callbacks = held; held = []; callbacks.forEach(release => release()); };
test.stopAudioFixture = stopAudioPreview;
test.stopAudioFolderFixture = async path => (await import("../../../src/lib/audioPreview")).stopAudioPreviewInFolder(path);
test.__TAURI_INTERNALS__ = {
  convertFileSrc: path => /^[a-z]:[/\\]|^[/\\]{2}/i.test(path) ? "/.tmp/audio-waveform-production/a.wav" : path,
  invoke: async (command, args) => {
    if (command !== "audio_waveform") throw new Error(`Unexpected IPC ${command}`);
    test.waveformCalls.push(args); test.peakActive++; test.peakMaximum = Math.max(test.peakMaximum, test.peakActive);
    const sourceVersion = test.sourceVersions[args.assetId] || "fingerprint-1";
    if (test.holdPeaks) await new Promise<void>(resolve => held.push(resolve));
    try {
      if (test.waveformFailures.includes(args.assetId)) throw new Error("decoder failed at C:\\private\\audio.wav");
      const data = await (await fetch("/.tmp/audio-waveform-production/peaks.json")).json();
      return { ...data, sourceVersion };
    } finally { test.peakActive--; }
  },
};
function Fixture() {
  const [items, setItems] = useState<Item[]>(["a", "b", "c", "d", "e", "f"].map(assetId => ({ assetId })));
  test.setAudioFixtureItems = setItems;
  return <><header style={{ height: 62 }} tabIndex={0}>素材库</header><main style={{ height: "calc(100vh - 62px)", overflow: "auto" }} className="production-scroll">
    <div style={{ position: "relative", height: Math.max(700, ...items.map((item, index) => (item.top ?? Math.floor(index / 3) * 224) + 210)) }}>
      {items.map((item, index) => <article data-item={item.instance || item.assetId} key={item.instance || item.assetId}
        style={{ position: "absolute", top: item.top ?? Math.floor(index / 3) * 224, left: index % 3 * 344 + 28, width: 316 }}
        onClick={() => { test.parentClicks++; }}>
        <AudioWaveform assetId={item.assetId} path={item.path || `/.tmp/audio-waveform-production/${item.assetId}.wav`}
          name={`${item.assetId}.wav`} version={item.version || "display-1"} expectedVersion={item.expectedVersion}
          duration={test.resolvedDurations[item.assetId]} interactive={item.interactive} onDuration={duration => {
            test.resolvedDurations[item.assetId] = duration; test.durationUpdates[item.assetId] = (test.durationUpdates[item.assetId] || 0) + 1;
          }} />
      </article>)}
    </div></main></>;
}
document.body.className = "library-tactical";
document.body.style.cssText = "margin:0;background:var(--lt-base);color:var(--lt-ink);font:14px sans-serif";
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
