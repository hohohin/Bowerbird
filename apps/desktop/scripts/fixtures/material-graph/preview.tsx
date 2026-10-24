import React from "react";
import { createRoot } from "react-dom/client";
import { LibraryHome } from "../../../src/components/LibraryHome";
import { CategorizedLibrary } from "../../../src/components/CategorizedLibrary";
import { LibrarySourceTabs } from "../../../src/components/LibrarySourceTabs";
import { useLocalFileMode } from "../../../src/lib/localFileMode";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";
import "../../../src/components/LocalFileWorkspace.css";

const w = window as any;
const listeners = new Map<number, (event: unknown) => void>();
let callback = 0;
w.requests = []; w.delay = 0; w.fail = false; w.large = false;
w.store = useStore; w.mode = useLocalFileMode;
const names = ["平面设计", "建筑空间", "自然植物", "品牌视觉", "人物摄影", "三维艺术", "产品静物", "版式字体"];
const assets = Array.from({ length: 242 }, (_, i) => ({ id: `asset-${i}`, name: `${names[i % 8]} · 灵感 ${i + 1}`, ext: "jpg", width: 360, height: 480,
  store_path: `/fixture/${i}.jpg`, thumb_path: w.demoImages?.[i % w.demoImages.length] ?? null, source: "imported", generation_session_id: i % 2 ? "g" : null,
  tags: i >= 240 ? [] : [i % 8, ...(i < 100 && i % 8 !== 0 ? [0] : [])] }));
const largeAssets = Array.from({length:5000}, (_, i) => ({ ...assets[i % 240], id:`large-${String(i).padStart(6,'0')}`, tags:[i % 60] }));
function filtered(filter: any) {
  return (w.large ? largeAssets : assets).filter(a => (!filter.projectId || Number(a.id.split('-')[1]) < 20) && (!filter.query || a.name.includes(filter.query))
    && (filter.generated == null || !!a.generation_session_id === filter.generated) && (!filter.color || a.tags.includes(2)) && filter.media === "images");
}
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.__TAURI_INTERNALS__ = {
  transformCallback: (fn: (event: unknown) => void) => { listeners.set(++callback, fn); return callback; },
  convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: any = {}) => {
    if (command === "plugin:event|listen") return args.handler;
    if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return; }
    w.requests.push({ command, args });
    if (command === "catalog_overview") {
      const list = filtered(args.filter);
      return { total: list.length, untagged: list.filter(a => !a.tags.length).length,
        catalog: { tags: Array.from({length:w.large ? 60 : names.length},(_, i) => ({ id: `tag-${i}`, name: names[i] ?? `分类 ${i}`, description: "", projectCount: 0,
          count: list.filter(a => a.tags.includes(i)).length })), collections: [], prompts: [], tag_asset_ids: {} } };
    }
    if (command === "catalog_graph_page") {
      const list = filtered(args.filter).filter(a => args.after == null || a.id > args.after).sort((a,b) => a.id < b.id ? -1 : 1);
      const items = list.slice(0, w.large ? 512 : 48);
      await new Promise(r => setTimeout(r,w.delay || 10));
      if (w.fail) throw new Error("模拟图谱读取失败");
      return { assets:items.map(a => ({id:a.id,name:a.name,store_path:a.store_path,thumb_path:a.thumb_path,tag_ids:a.tags.map(i => `tag-${i}`)})), after:items.length < list.length ? items.at(-1)!.id : null };
    }
    if (command === "catalog_page") {
      const list = filtered(args.filter).filter(a => !args.filter.id || (args.filter.id === "__catalog_untagged__" ? !a.tags.length : a.tags.includes(Number(args.filter.id.split('-')[1]))));
      await new Promise(r => setTimeout(r, w.delay || 20));
      if (w.fail) throw new Error("模拟图谱读取失败");
      return list.slice(args.offset, args.offset + args.limit);
    }
    if (command === "catalog_prepare_colors") return { after: null, more: false, failed: 0, updated: 0 };
    if (command === "external_files_media") return assets[0].thumb_path;
    if (command === "get_asset") return assets.find(a => a.id === args.id || a.id === args.assetId);
    throw new Error(`Unexpected IPC: ${command}`);
  },
};
w.refresh = () => listeners.forEach(fn => fn({ payload: null }));
useStore.setState({ activeProjectId: null, libraryThumbnailWidth: 150 });
function Fixture() {
  const [project, setProject] = React.useState(false);
  w.project = setProject;
  return <><input aria-label="搜索素材" style={{ position: "absolute", top: 8, left: 20, width: 240, zIndex: 60 }} placeholder="搜索素材" onChange={e => useLocalFileMode.getState().setQuery(e.target.value)}/>
    <div style={{ position: "fixed", inset: "44px 0 0" }}>{project ? <CategorizedLibrary kind="tags" projectId="project-fixture" projectScope
      navigation={<header className="library-browser-heading"><LibrarySourceTabs value="project" project onChange={() => {}}/></header>} onClose={() => {}}/>
      : <LibraryHome/>}</div></>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
