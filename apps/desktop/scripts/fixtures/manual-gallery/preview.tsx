import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CreationBoard } from "../../../src/components/CreationBoard";
import { GenerationPanel } from "../../../src/components/GenerationPanel";
import { AssetContextMenu } from "../../../src/components/AssetContextMenu";
import { useStore } from "../../../src/store";
import { listenForNotices } from "../../../src/lib/notify";
import "../../../src/styles.css";
import "../../../src/components/IndustrialTheme.css";
import "../../../src/components/IndustrialCanvas.css";
import "../../../src/components/IndustrialMenus.css";

const w=window as any;
w.calls=[];w.previous={p:"previous",q:null};w.notices=[];w.store=useStore;
listenForNotices(detail=>w.notices.push(detail));
w.__TAURI_INTERNALS__={convertFileSrc:(path:string)=>path,transformCallback:()=>1,
  invoke:async(command:string,args:any)=>{
    w.calls.push({command,args});
    if(command==="previous_gallery_generation") return w.previous[args.projectId]??null;
    if(command==="list_gen_jobs") return [];
    if(command==="recent_gen_sessions" && args.jobId==="previous") return [{
      id:"previous", project_id:"p", thread_id:"original-thread", provider:"codex", media:"image", status:"done",
      created_at:1700000000, references:[], ref_assets:[], prompt:"改变杯子的角度",
      turns:["蓝色玻璃杯的棚拍","改变杯子的角度"].map((prompt,i)=>({prompt,prompt_raw:prompt,turn_key:"turn-"+i,images:[]})),
    }];
    if(command==="recent_gen_sessions") return [];
    if(command==="merge_generation_galleries") {
      if(w.failMerge) throw new Error("模拟合组失败");
      return {groupKey:"manual:test",previous:{"generation:previous":null,"generation:new":null}};
    }
    if(command==="undo_generation_gallery_merge") return;
    if(command==="plugin:event|listen") return 1;
    if(command==="plugin:event|unlisten") return;
    if(command==="get_settings") return {};
    if(command==="list_visual_profiles"||command==="list_presets"||command==="list_asset_tags"||command==="list_generation_group") return [];
    if(command==="get_assets_by_ids") return useStore.getState().assets.filter(a=>args.assetIds.includes(a.id));
    throw new Error(`Unexpected IPC: ${command}`);
  }};
const assets=["a","b"].map(id=>({id,name:id,ext:"png",store_path:`/${id}.png`,generation_session_id:id}));
useStore.setState({activeProjectId:"p",boardOpen:true,activeGenProvider:"codex",defaultProvider:"codex",codexHealth:{ok:true},
  cloudAuth:{logged_in:true,cloud_available:true,user_id:"test"} as any,cloudEntitlement:{plan:"pro",policy:{can_use_byo:true,max_parallel_jobs:4},balances:{daily:100,sub:0,topup:0}} as any,
  assets:assets as any,settings:{} as any,exitCreationMode:()=>{},
  startGeneration:async(...args:any[])=>{
    w.started=args;
    if(w.holdStart) await new Promise<void>(resolve=>{w.releaseStart=resolve;});
    if(w.rejectStart) return {accepted:false,jobId:"new",error:"模拟提交失败"};
    const job={id:"new",media:"image",projectId:args[9]?.projectId??"p",threadId:"t",turns:[],running:true,createdAt:Date.now()} as any;
    useStore.setState(state=>({genJobs:{...state.genJobs,new:job},genJobOrder:[...state.genJobOrder,"new"]}));
    return {accepted:true,jobId:"new"};
  }});
function Fixture(){
  const panelOpen=useStore(state=>state.genPanelOpen);
  const [project,setProject]=useState("p");w.switchProject=(id:string)=>{useStore.setState({activeProjectId:id});setProject(id);};
  const [mount,setMount]=useState(0);w.remount=()=>setMount(n=>n+1);
  w.openMulti=()=>useStore.setState({mode:"manage",selectedIds:new Set(["a","b"]),contextMenu:{assetId:"a",x:50,y:70}} as any);
  return <main style={{position:"fixed",inset:0,overflow:"hidden"}}><CreationBoard key={mount} embedded projectId={project}
    resolveCreativeThread={async()=>({threadId:"t",parentNodeId:null})}/>{panelOpen && <aside data-testid="session"><GenerationPanel embedded /></aside>}<AssetContextMenu/></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
