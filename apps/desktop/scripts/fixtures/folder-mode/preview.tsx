import React from "react";
import { createRoot } from "react-dom/client";
import { LocalFileWorkspace } from "../../../src/components/LocalFileWorkspace";
import { PreservedWorkspace } from "../../../src/components/PreservedWorkspace";
import { Toolbar } from "../../../src/components/Toolbar";
import { useStore } from "../../../src/store";
import { useLocalFileMode } from "../../../src/lib/localFileMode";
import "../../../src/styles.css";
const w = window as any;
w.calls=[]; w.store=useStore; w.mode=useLocalFileMode;
const poster='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="#d7cfb6"/><circle cx="120" cy="90" r="45" fill="#718b75"/></svg>');
const label={id:'folder-label',name:'自然',description:'本文件夹专用',enabled:true,count:1,has_examples:false};
w.__TAURI_INTERNALS__={convertFileSrc:(path:string)=>path.endsWith('.png')?poster:path,transformCallback:()=>1,metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},invoke:async(command:string,args:any={})=>{
  w.calls.push({command,args});
  if(command==='external_files_browse') {
    const path=args.path||'/pictures';
    if(path==='/missing') throw new Error('目录不可用');
    if(path==='/slow') await new Promise(r=>setTimeout(r,500));
    const entries=path==='/pictures'?[{path:'/pictures/sub',name:'旅行',directory:true},{path:'/pictures/photo.png',name:'photo.png',directory:false},{path:'/pictures/clip.mp4',name:'clip.mp4',directory:false}]:[{path:path+'/other.png',name:'other.png',directory:false}];
    return {path,parent:path==='/pictures'?'/': '/pictures',entries:args.offset?[]:entries,total:entries.length};
  }
  if(command==='external_files_preview') return poster;
  if(command==='external_files_media') return args.path;
  if(command==='folder_classification_view') return {root:args.path,record:{version:1,recursive:false,labels:args.path==='/pictures'?[label]:[],pictures:[{id:'folder-picture',path:'photo.png',fingerprint:'hash',tags:[['folder-label','local']],rejected:[],observation:null}]}};
  if(command==='local_classification_status') return {busy:false,installed:true,supported:true,model:'qwen',enabled:false,done:0,total:0,failed:0,message:'',last_error:'',current_asset:null,jev_progress:null};
  if(command==='folder_classification_edit') return 'folder-label';
  if(command==='folder_classification_start') return null;
  if(command==='get_settings') return {jev_image_classification_enabled:false,jev_api_key:null};
  if(command==='plugin:dialog|open') return '/picked';
  if(command.startsWith('plugin:event|')) return 1;
  throw new Error('Unexpected IPC '+command);
}};
useStore.setState({searchQuery:'主库搜索',selectedIds:new Set(['library-selection']),smartFilter:'tag:主库标签'});
function App(){
 const opened=useLocalFileMode(s=>s.open);const setOpen=useLocalFileMode(s=>s.setOpen);
 return <div className="app-shell" style={{height:'100vh',display:'flex',flexDirection:'column'}}>
   <Toolbar onRefresh={async()=>{}} canvasMode={false} onCanvasModeChange={()=>{}} onCreateCreative={()=>{}} onExplore={()=>{}} localFilesOpen={opened} onLocalFiles={()=>setOpen(!opened)}/>
   <main className="relative flex min-h-0 flex-1 flex-col bg-canvas">
     {opened&&<LocalFileWorkspace onClose={()=>setOpen(false)} onCreateProject={async()=>{}}/>}
     <PreservedWorkspace suspended={opened}><div data-testid="library-scroller" style={{overflow:'auto',height:'100%'}}><div style={{height:2200}}>原素材库瀑布流</div></div></PreservedWorkspace>
   </main>
 </div>;
}
document.documentElement.dataset.theme='light';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
