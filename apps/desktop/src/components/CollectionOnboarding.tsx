import { useState } from "react";
import { api } from "../lib/api";
import { useOnboarding } from "../lib/onboardingStore";
import { useStore } from "../store";
import { ModalShell } from "./ModalShell";
import "./OnboardingTour.css";

const COLLECTION_STEPS = [
  ["按品牌或主题建集合", "在侧栏「集合」旁点击 +，取一个容易识别的名字，例如「春季品牌参考」。项目用来创作，集合用来整理素材库中的参考图片。"],
  ["把相关素材放进来", "打开集合，点击「添加素材」，在素材库选图后确认添加；也可以直接粘贴图片，或把本地图片文件拖进集合。已有图片加入集合会改变集合归属，不会复制图片或改变已有画板布局。"],
  ["从一组参考提炼视觉规范", "选取风格相近的图片，点击集合中的「提炼视觉规范」。先查看图片分析用量与总结费用，再主动点击「开始提炼」；只整理素材时，可以跳过提炼。"],
  ["保存后，在创作中选择", "检查提炼结果并点击「保存规范」，再到创作输入中主动选择该规范。保存不会自动选用；同一份规范可以在不同项目中复用。"],
] as const;

function CollectionGuideContent() {
  return <ol className="collection-learning-steps">{COLLECTION_STEPS.map(([title, body], i) =>
    <li key={title}><strong>{i + 1}. {title}</strong><p>{body}</p></li>
  )}</ol>;
}

/** Inline instructions remain available after dismissal, including in an empty collection. */
export function CollectionLearning() {
  const { progress, patch } = useOnboarding();
  const expanded = !progress.dismissed.includes("collections");
  return <details className="collection-learning" open={expanded} onToggle={event => {
    const open = event.currentTarget.open;
    if (open === expanded) return;
    patch({ dismissed: open ? progress.dismissed.filter(id => id !== "collections") : [...progress.dismissed, "collections"] });
  }}>
    <summary>集合入门 · 整理参考与提炼视觉规范</summary>
    <CollectionGuideContent />
  </details>;
}

export function CollectionOnboarding() {
  const { patch, show } = useOnboarding();
  const folders = useStore(s => s.folders).filter(folder => folder.id !== "root" && (folder.kind ?? "folder") === "folder");
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function openCollection(create: boolean) {
    if (busy || (create ? !name.trim() : !selectedId)) return;
    setBusy(true); setError("");
    try {
      await useStore.getState().projectCanvasFlush?.();
      // UI 集合 corresponds to a normal folder; kind=collection is the separate 收藏夹.
      const id = create ? await api.createFolder(name.trim()) : selectedId;
      if (create) {
        // Keep the new identity if refresh fails, so retry opens it instead of creating a duplicate.
        setSelectedId(id); setName("");
      }
      const latest = await api.listFolders();
      useStore.getState().setFolders(latest);
      if (!latest.some(folder => folder.id === id && (folder.kind ?? "folder") === "folder"))
        throw new Error("集合已不存在，请重新选择或创建集合。");
      patch({ dismissed: useOnboarding.getState().progress.dismissed.filter(topic => topic !== "collections") });
      show("closed");
      useStore.getState().setCollectionPanel(id);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <ModalShell title="用集合整理参考，提炼视觉规范" eyebrow="集合入门" width="md" preventClose={busy}
    description="先把同一品牌或主题的图片整理到一起，再按需提炼可复用的视觉规范。"
    onClose={() => show("welcome")}
    footer={<button className="app-modal-button" disabled={busy} onClick={() => show("welcome")}>返回入门引导</button>}>
    <CollectionGuideContent />
    <form className="collection-learning-start" onSubmit={event => { event.preventDefault(); void openCollection(true); }}>
      <label htmlFor="lesson-collection-name">创建你的第一个集合</label>
      <div><input id="lesson-collection-name" className="app-form-input" placeholder="例如：春季品牌参考" value={name}
        disabled={busy} onChange={event => setName(event.target.value)} />
        <button className="app-modal-button is-primary" disabled={busy || !name.trim()} type="submit">创建并打开集合</button></div>
    </form>
    {(folders.length > 0 || selectedId) && <div className="collection-learning-start">
      <label htmlFor="lesson-existing-collection">也可以使用已有集合</label>
      <div><select id="lesson-existing-collection" className="app-form-input" disabled={busy} value={selectedId} onChange={event => setSelectedId(event.target.value)}>
        <option value="">选择集合</option>
        {selectedId && !folders.some(folder => folder.id === selectedId) && <option value={selectedId}>刚创建的集合</option>}
        {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </select><button className="app-modal-button" disabled={busy || !selectedId} onClick={() => void openCollection(false)}>打开所选集合</button></div>
    </div>}
    {error && <p className="mt-3 text-sm text-red-400" role="alert">{error}</p>}
  </ModalShell>;
}
