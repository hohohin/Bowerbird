import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUp, Moon, RotateCcw, Sun, X } from "lucide-react";
import { CreationImagePreview } from "../../../src/components/CreationImagePreview";
import { useStore } from "../../../src/store";
import type { Asset, GenJob } from "../../../src/lib/types";
import "../../../src/styles.css";
import "../../../src/components/TacticalProjection.css";
import "../../../src/components/TacticalDialogs.css";
import "../../../src/components/CanvasSecondaryTactical.css";
import "../../../src/components/MediaTactical.css";
import "../../../src/components/IndustrialTheme.css";
import "../../../src/components/IndustrialCanvas.css";
import "../../../src/components/IndustrialMenus.css";
import "./preview.css";

// Independent review page. Repository demo images and synthetic read-only IPC only.
const assets: Asset[] = [
  { id: "review-one", name: "城市肖像 · 画面一", store_path: "/src-tauri/resources/samples/preset-13.png", width: 941, height: 1672, ext: "png", generation_session_id: "review-session" },
  { id: "review-two", name: "花影 · 画面二", store_path: "/src-tauri/resources/samples/preset-14.png", width: 1086, height: 1448, ext: "png", generation_session_id: "review-session" },
];
const job: GenJob = {
  id: "review-job", projectId: "review-project", sessionId: "review-session", provider: "codex",
  running: false, streaming: "", createdAt: 1, lastPrompt: "黑色衣装的城市肖像，自然光，安静的街角。", lastRefs: [], refAssets: [],
  turns: [
    { id: 1, turnKey: "review-first", prompt: "黑色衣装的城市肖像，自然光，安静的街角。", promptRaw: "黑色衣装的城市肖像，自然光，安静的街角。", refs: [], refAssets: [], images: [assets[0].store_path!] },
    { id: 2, turnKey: "review-second", prompt: "改成低机位的时装大片，加入巨大的红白花朵，保持黑色衣装。", promptRaw: "改成低机位的时装大片，加入巨大的红白花朵，保持黑色衣装。", refs: [], refAssets: [], images: [assets[1].store_path!] },
  ],
};
const host = window as any;
const callbacks = new Map<number, unknown>();
host.__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => path,
  transformCallback: (callback: unknown) => { const id = callbacks.size + 1; callbacks.set(id, callback); return id; },
  metadata: { currentWindow: { label: "review" }, currentWebview: { label: "review" } },
  invoke: async (command: string) => {
    if (command === "plugin:event|listen") return 1;
    if (command === "plugin:event|unlisten") return;
    if (command === "get_assets_by_ids") return assets;
    if (command === "generation_history") return { session_id: null, references: [], turns: [] };
    throw new Error(`示意页不执行原生操作：${command}`);
  },
};
host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
useStore.setState({ assets, genJobs: { [job.id]: job }, genJobOrder: [job.id], boardOpen: true, genPanelOpen: false, activeJobId: null, genEditing: null });

function Review() {
  const [theme, setTheme] = useState("dark");
  const [shown, setShown] = useState<Asset | null>(assets[1]);
  const [version, setVersion] = useState(0);
  const [references, setReferences] = useState<Asset[]>([]);
  const [draft, setDraft] = useState("沿用这张图的光线与配色，尝试一个新的构图。");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector<HTMLButtonElement>(".creation-image-preview-image-head button")?.focus({ preventScroll: true });
  }, [theme]);
  useEffect(() => () => clearTimeout(timer.current), []);
  function preview(asset: Asset) { clearTimeout(timer.current); setShown(asset); }
  function single(event: React.MouseEvent, asset: Asset) {
    clearTimeout(timer.current);
    if (event.detail === 0) preview(asset);
    else if (event.detail === 1) timer.current = setTimeout(() => preview(asset), 500);
  }
  function reference(asset: Asset) {
    clearTimeout(timer.current);
    setReferences(previous => previous.some(item => item.id === asset.id) ? previous : [...previous, asset]);
  }
  function replay() { clearTimeout(timer.current); setVersion(value => value + 1); setShown(assets[1]); }
  return <main className="image-review-page">
    <header className="image-review-topbar">
      <span className="image-review-badge">正式组件 · 交互示意</span>
      <nav aria-label="示意选项">
        <button type="button" onClick={replay} title="重播展开动效"><RotateCcw size={14}/>重播</button>
        <button type="button" onClick={() => setTheme(value => value === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? "切换浅色" : "切换深色"}>
          {theme === "dark" ? <Sun size={15}/> : <Moon size={15}/>} {theme === "dark" ? "浅色" : "深色"}
        </button>
      </nav>
    </header>
    <section className="image-review-canvas" aria-label="图片交互示意画布">
      <div className="image-review-canvas-title"><span/>花影创作</div>
      <div className="image-review-cards">
        {assets.map((asset, index) => <article key={asset.id} className="image-review-card" role="button" tabIndex={0}
          aria-label={`会话卡片 ${asset.name}，单击查看详情`} onClick={event => single(event, asset)}
          onPointerDown={() => clearTimeout(timer.current)} onKeyDown={event => {
            if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); preview(asset); }
          }}>
          <span className="image-review-card-name">{asset.name}</span>
          <button type="button" aria-label={`${asset.name}，单击查看，双击引用`}
            onDoubleClick={event => { event.stopPropagation(); reference(asset); }}>
            <img src={asset.store_path!} alt={asset.name} draggable={false}/>
            <span className="image-review-number">0{index + 1}</span>
          </button>
          <p className="image-review-card-copy">{job.turns[index].prompt}</p>
        </article>)}
      </div>
      <span className="image-review-gesture">单击查看 · 双击引用</span>
      <section className="image-review-composer" aria-label="示意创作框">
        <div className="image-review-composer-head"><span/>创作描述</div>
        {!!references.length && <div className="image-review-references">{references.map(asset => <div key={asset.id} className="image-review-reference">
          <img src={asset.store_path!} alt=""/><span>{asset.name}</span>
          <button type="button" onClick={() => setReferences(previous => previous.filter(item => item.id !== asset.id))} aria-label={`移除引用 ${asset.name}`}><X size={12}/></button>
        </div>)}</div>}
        <textarea aria-label="创作草稿" value={draft} onChange={event => setDraft(event.target.value)}/>
        <button className="image-review-send" type="button" disabled title="示意页不提交生成任务" aria-label="发送（示意页不可用）"><ArrowUp size={16}/></button>
      </section>
    </section>
    {shown && <CreationImagePreview key={`${shown.id}:${version}`} asset={shown} projectId="review-project" job={job} onClose={() => setShown(null)}/>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Review/>);
