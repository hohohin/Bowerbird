import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../src/styles.css";
import "../../../src/components/TacticalDialogs.css";
import "../../../src/components/IndustrialTheme.css";
import { VideoCollectionDialog } from "../../../src/components/VideoCollectionDialog";
const w = window as any;
w.calls = []; w.collected = []; w.tasks = []; w.failSave = false;
w.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  w.calls.push({command,args});
  if (command !== "video_collection") throw new Error(command);
  const {action,data,projectId} = args;
  if (action === "list") return structuredClone(w.tasks);
  if (action === "create") {
    const task = {id:"one",kind:"direct",state:"downloading",projectId:projectId || "",sourceUrl:data.text,shareText:data.text,message:"正在下载视频",downloadedBytes:1048576};
    w.tasks = [task]; return structuredClone(task);
  }
  if (action === "save") {
    if (w.failSave) { w.failSave = false; throw new Error("SQLITE_BUSY: private internal path C:/private"); }
    if (w.holdSave) await new Promise(resolve => {w.releaseSave = resolve;});
    w.tasks[0].assetId = "asset";
    return {id:"asset",name:"视频.mp4",ext:"mp4",store_path:"video.mp4",duration:3};
  }
  if (action === "cancel") { w.tasks[0].state="cancelled"; return structuredClone(w.tasks[0]); }
  if (action === "retry" || action === "login") { w.tasks[0].state="ready"; w.tasks[0].reference={id:"ref",name:"视频.mp4",duration:3}; return structuredClone(w.tasks[0]); }
  throw new Error(action);
}};
function App() {
  const [open,setOpen] = useState(true), [project,setProject] = useState<string|null>(location.search.includes("global") ? null : "original");
  w.switchProject = () => setProject("other");
  return <><button onClick={() => setOpen(true)}>打开采集</button>{open && <VideoCollectionDialog projectId={project} onClose={() => setOpen(false)}
    ensureProject={async () => {w.calls.push({command:'ensure-project',args:{}}); if(w.failEnsure) {w.failEnsure=false; throw new Error("项目未能保存，请重试");}}}
    onCollected={async (asset,owner,addToCanvas) => {
      if(w.holdCallback) await new Promise(resolve => {w.releaseCallback = resolve;});
      if(w.failCallback) {w.failCallback=false; throw new Error("画板写入失败，请重试");}
      w.collected.push({asset,owner,addToCanvas});
    }} />}</>;
}
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") || "light";
createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
