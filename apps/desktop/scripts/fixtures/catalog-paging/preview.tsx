import React from "react";
import { createRoot } from "react-dom/client";
import { CategorizedLibrary } from "../../../src/components/CategorizedLibrary";
import { useLocalFileMode } from "../../../src/lib/localFileMode";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";
import "../../../src/components/LocalFileWorkspace.css";
import type { CatalogFilter } from "../../../src/lib/materialCatalog";
const w = window as any;
const listeners = new Map<number, (event: unknown) => void>();
let callbackId = 0;
const thumb = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#7b9eaa"/></svg>');
w.total = 300000; w.requests = []; w.inFlight = 0; w.maxInFlight = 0; w.failOffset = -1; w.delay = 0;
w.mode = useLocalFileMode; w.store = useStore;
const asset = (i: number) => ({ id: `asset-${i}`, name: `素材${i}.png`, ext: "png", source: "imported", width: 240, height: i % 5 ? 160 : 320,
  store_path: `/asset-${i}.png`, thumb_path: thumb, generation_session_id: i % 2 ? "generated" : null });
function range(f: CatalogFilter) {
  let first = f.id === "last" ? Math.max(0,w.total - 60) : 0;
  let count = f.id === "last" ? Math.min(60,w.total) : w.total;
  if (f.query) count = f.query === "small" ? 180 : f.query === "slow" ? 120 : f.query === "empty" ? 0 : 3;
  if (f.projectId) count = Math.min(count,120);
  if (f.kind === "collections") count = f.id ? Math.min(count,90) : 0;
  if (f.color) count = Math.min(count,30);
  if (f.media === "videos") count = 0;
  return { first, count };
}
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.__TAURI_INTERNALS__ = {
  transformCallback: (fn: (event: unknown) => void) => { listeners.set(++callbackId, fn); return callbackId; },
  convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: any = {}) => {
    if (command === "plugin:event|listen") return args.handler;
    if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return; }
    w.requests.push({command,args});
    if(command === "catalog_prepare_colors") return {after:null,more:false,failed:0,updated:0};
    if (command === "catalog_overview") {
      if (args.filter.query === "slow") await new Promise(r => setTimeout(r,400));
      const {count} = range(args.filter);
      return { total: count, untagged: 0, catalog: { tags: [
        {id:"first",name:"A 素材",count,projectCount:0,description:""},
        {id:"last",name:"Z 末尾",count:Math.min(count,60),projectCount:1,description:""}],
        prompts:[],tag_asset_ids:{},collections:[{id:"collection",name:"集合",kind:"collection",parent_id:null}] } };
    }
    if (command === "catalog_page") {
      w.maxInFlight = Math.max(w.maxInFlight,++w.inFlight);
      try {
        await new Promise(r => setTimeout(r,w.delay || 20));
        if (w.failOffset === args.offset) throw new Error("模拟分页读取失败");
        const {first,count} = range(args.filter);
        return Array.from({length:Math.min(args.limit,Math.max(0,count-args.offset))},(_,i)=>asset(first+args.offset+i));
      } finally { w.inFlight--; }
    }
    if (command === "catalog_ids") {
      const {first,count}=range(args.filter);
      return Array.from({length:Math.min(args.limit,Math.max(0,count-args.offset))},(_,i)=>`asset-${first+args.offset+i}`);
    }
    if (command === "get_assets_by_ids") return args.assetIds.map((id:string)=>asset(Number(id.split('-')[1])));
    if (command === "external_file_media") return thumb;
    if (command === "set_collection_members") { w.assigned = args.assetIds; return; }
    throw new Error(`Unexpected IPC: ${command}`);
  },
};
w.refresh = () => listeners.forEach(fn => fn({payload:null}));
useStore.setState({activeProjectId:null,libraryThumbnailWidth:150});
function Fixture() {
  const [kind,setKind] = React.useState<"all"|"tags"|"collections">("all");
  const [project,setProject] = React.useState(false);
  w.changeKind=setKind; w.changeProject=setProject;
  return <div style={{position:"fixed",inset:0}}><CategorizedLibrary key={`${kind}:${project}`} kind={kind} projectId={project?"p":null} projectScope={project}
    navigation={<input aria-label="搜索素材" onChange={e=>useLocalFileMode.getState().setQuery(e.target.value)}/>}
    onClose={()=>{}} onCreateProject={async ids=>{w.created=ids;}}/></div>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
