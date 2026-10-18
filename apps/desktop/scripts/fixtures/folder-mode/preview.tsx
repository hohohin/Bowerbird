import React from "react";
import { createRoot } from "react-dom/client";
import { LocalFileWorkspace } from "../../../src/components/LocalFileWorkspace";
import { PreservedWorkspace } from "../../../src/components/PreservedWorkspace";
import { LibraryViewSwitch } from "../../../src/components/LibraryViewSwitch";
import { useLibraryTabOrder } from "../../../src/lib/libraryTabOrder";
import { Toolbar } from "../../../src/components/Toolbar";
import { useStore } from "../../../src/store";
import { useLocalFileMode } from "../../../src/lib/localFileMode";
import { prepareFileWorkspace } from "../../../src/lib/fileWorkspace";
import "../../../src/styles.css";
const w = window as any;
w.calls=[]; w.store=useStore; w.mode=useLocalFileMode;
w.prepareFiles=prepareFileWorkspace;
let fileConfig={root:null as string|null,places:[] as string[],projects:{} as Record<string,string>};
const poster='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="#d7cfb6"/><circle cx="120" cy="90" r="45" fill="#718b75"/></svg>');
const label={id:'folder-label',name:'自然',description:'本文件夹专用',enabled:true,count:3,has_examples:false};
let labels=[label];
const pictures=['photo.png','sub/other.png','sub/deep/forest.png'].map((path,i)=>({id:i?`folder-picture-${i}`:'folder-picture',path,fingerprint:'hash',tags:[['folder-label','local']],rejected:[],observation:null}));
w.__TAURI_INTERNALS__={convertFileSrc:(path:string)=>path.endsWith('.png')?poster:path,transformCallback:()=>1,metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},invoke:async(command:string,args:any={})=>{
  w.calls.push({command,args});
  if(command==='file_workspace_status') return {config:fileConfig,proposed_root:'/BowerbirdLibrary',migration:w.fileMove||null};
  if(command==='file_workspace_move_preview') {
    if(w.fileMoveError) throw new Error(w.fileMoveError);
    return {source:'/BowerbirdLibrary',target:args.parent+'/BowerbirdLibrary',files:12,bytes:1024*1024*24,projects:2,token:'move-token'};
  }
  if(command==='file_workspace_move_schedule') {
    if(w.fileMoveDelay) await new Promise(r=>setTimeout(r,w.fileMoveDelay));
    if(w.fileMoveError) throw new Error(w.fileMoveError);
    w.fileMove={id:'move',state:'pending',source:'/BowerbirdLibrary',target:args.parent+'/BowerbirdLibrary',error:null};
    return null;
  }
  if(command==='file_workspace_move_cancel') {w.fileMove={...w.fileMove,state:'cancelled'};return null;}
  if(command==='file_workspace_history_preview') {
    if(w.fileMoveError) throw new Error(w.fileMoveError);
    return {source:'/old/images',target:'/BowerbirdLibrary',files:w.historyEmpty?0:8,bytes:1024*1024*16,projects:2,global:3,shared:2,token:'history-token',folders:[{id:'p1',name:'海报',path:'/BowerbirdLibrary/项目/海报-p1',files:4},{id:'p2',name:'品牌',path:'/BowerbirdLibrary/项目/品牌-p2',files:1}]};
  }
  if(command==='file_workspace_history_schedule') {
    if(w.fileMoveDelay) await new Promise(r=>setTimeout(r,w.fileMoveDelay));
    if(w.fileMoveError) throw new Error(w.fileMoveError);
    w.fileMove={id:'history',state:'pending',source:'/old/images',target:'/BowerbirdLibrary',history:{},error:null};return null;
  }
  if(command==='restart_app') {if(w.restartError) throw new Error(w.restartError);return null;}
  if(command==='file_workspace_restore_preview') {
    const value={token:'preview-token',items:w.recordItems||[]};
    if(w.recordPreviewDelay) await new Promise(r=>setTimeout(r,w.recordPreviewDelay));
    if(w.recordPreviewError) throw new Error(w.recordPreviewError);
    return value;
  }
  if(command==='file_workspace_restore') {
    if(w.recordRestoreDelay) await new Promise(r=>setTimeout(r,w.recordRestoreDelay));
    if(w.recordRestoreError) throw new Error(w.recordRestoreError);
    w.recordItems=w.recordItems.map((item:any)=>({...item,action:item.action==='blocked'?'blocked':'existing'}));
    return {imported:1,relinked:1};
  }
  if(command==='file_workspace_save_records') return {total:3,pending:1,local:1};
  if(command==='file_workspace_prepare') {
    if(w.rootUnwritable&&!args.root) throw new Error('FILE_ROOT_REQUIRED:资料目录不可写');
    fileConfig={...fileConfig,root:args.root||fileConfig.root||'/BowerbirdLibrary'};
    return args.projectId?fileConfig.root+'/项目/'+args.projectId:fileConfig.root;
  }
  if(command==='file_workspace_place') {
    fileConfig={...fileConfig,places:[...fileConfig.places.filter(p=>p!==args.path),...(args.added?[args.path]:[])]};
    return fileConfig;
  }
  if(command==='file_workspace_all') return {entries:fileConfig.places.map(path=>({path:path+'/photo.png',name:'photo.png',directory:false})),unavailable:w.offlineLocations||[]};
  if(command==='set_active_project') return null;
  if(command==='external_files_browse') {
    const path=args.path||'/pictures';
    if(path==='/missing') throw new Error('目录不可用');
    if(path==='/slow') await new Promise(r=>setTimeout(r,500));
    const entries=path==='/pictures'?[{path:'/pictures/sub',name:'旅行',directory:true},{path:'/pictures/photo.png',name:'photo.png',directory:false},{path:'/pictures/clip.mp4',name:'clip.mp4',directory:false}]:[{path:path+'/other.png',name:'other.png',directory:false}];
    return {path,parent:path==='/pictures'?'/': '/pictures',entries:args.offset?[]:entries,total:entries.length};
  }
  if(command==='external_files_preview') return poster;
  if(command==='external_files_media') return args.path;
  if(command==='external_files_index') return {id:'explicit-copy',external_path:args.path};
  if(command==='external_files_copy') return {id:args.assetId};
  if(command==='folder_classification_view') return {root:args.path.startsWith('/pictures')?'/pictures':args.path,record:{version:1,recursive:true,labels:args.path.startsWith('/pictures')?labels:[],pictures}};
  if(command==='folder_classification_images') {
    if(w.tagDelay) await new Promise(r=>setTimeout(r,w.tagDelay));
    if(w.tagFailure) throw new Error('分类目录不可用');
    return pictures.map(p=>({path:'/pictures/'+p.path,name:p.path.split('/').pop(),directory:false})).filter(p=>p.path.startsWith(args.path+'/'));
  }
  if(command==='local_classification_status') return {busy:false,installed:w.modelInstalled!==false,supported:true,model:'qwen',enabled:false,done:0,total:0,failed:0,message:'',last_error:'',current_asset:null,jev_progress:null};
  if(command==='folder_classification_edit') {
    if(w.editFailure) throw new Error('分类记录只读');
    if(args.action==='save') {
      const id=args.id||'new-folder-label';
      const next={id,name:args.name,description:args.description,enabled:args.enabled,count:0,has_examples:false};
      labels=labels.some(l=>l.id===id)?labels.map(l=>l.id===id?next:l):[...labels,next];
      return id;
    }
    if(args.action==='delete') labels=labels.filter(l=>!args.ids.includes(l.id));
    return null;
  }
  if(command==='folder_classification_start') return null;
  if(command==='get_settings') return {jev_image_classification_enabled:false,jev_api_key:null};
  if(command==='plugin:dialog|open') return w.cancelFolderPicker?null:'/picked';
  if(command.startsWith('plugin:event|')) return 1;
  throw new Error('Unexpected IPC '+command);
}};
useStore.setState({searchQuery:'主库搜索',selectedIds:new Set(['library-selection']),smartFilter:'tag:主库标签'});
function App(){
 const opened=useLocalFileMode(s=>s.open);const setOpen=useLocalFileMode(s=>s.setOpen);
 const order=useLibraryTabOrder(s=>s.order);const setOrder=useLibraryTabOrder(s=>s.setOrder);
 const navigation=<header className="library-browser-heading"><LibraryViewSwitch value={opened?'files':'project'} label="主页视图" onChange={value=>setOpen(value==='files')} onReorder={setOrder} options={order.map(value=>({value,label:{project:'项目管理',files:'文件'}[value]}))}/></header>;
 return <div className="app-shell" style={{height:'100vh',display:'flex',flexDirection:'column'}}>
   <Toolbar onRefresh={async()=>{}} canvasMode={false} onCanvasModeChange={()=>{}} onCreateCreative={()=>{}} onExplore={()=>{}} localFilesOpen={opened}/>
   <main className="relative flex min-h-0 flex-1 flex-col bg-canvas">
     {opened&&<LocalFileWorkspace navigation={navigation} onClose={()=>setOpen(false)} onCreateProject={async()=>{}}/>}
     <PreservedWorkspace suspended={opened}>{navigation}<div data-testid="library-scroller" style={{overflow:'auto',height:'100%'}}><div style={{height:2200}}>原素材库瀑布流</div></div></PreservedWorkspace>
   </main>
 </div>;
}
document.documentElement.dataset.theme='light';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
