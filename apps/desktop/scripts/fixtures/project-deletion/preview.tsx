import React from 'react';
import {createRoot} from 'react-dom/client';
import {useProjectDeletion} from '../../../src/components/useProjectDeletion';
import {useStore} from '../../../src/store';
import '../../../src/styles.css';
const w=window as any;
w.calls=[]; w.notices=[]; w.failure=false; w.running=0; w.pending=false; w.pendingResults=[];
w.assets = ['山间小屋.png', '海报配色.png', '城市短片.mp4'].map((name, i) => ({id: `exclusive-${i}`, name, store_path: `/synthetic/${name}`, thumb_path: 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="${['#94a791','#b9a8ca','#a0b8ca'][i]}"/><circle cx="120" cy="80" r="40" fill="#fff" opacity=".55"/><path d="M0 180L90 80L210 180" fill="#354353" opacity=".5"/></svg>`)}));
const scans = new Map<string, { finish: (value: unknown) => void; cancelled: boolean }>();
const physicalImpact = () => ({exclusive_asset_count:w.assets.length,exclusive_asset_ids:w.assets.map((a:any)=>a.id),exclusive_file_count:6,preserved_shared_count:4,preserved_unsafe_count:1,confirmation:'test-confirmation'});
w.__TAURI_INTERNALS__={convertFileSrc:(path:string)=>path,transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,args:any)=>{
  w.calls.push({command,args});
  if(command==='project_delete_impact') {
    if(w.holdImpact) await new Promise(resolve=>{w.releaseImpact=resolve;});
    if(w.failImpact) throw 'synthetic load failure';
    return {project_asset_count:8,thread_count:2,node_count:13,running_generation_count:w.running,running_agent_count:w.pendingResults.length,pending_agent_results:w.pendingResults,physical:args.includePhysical===false?{exclusive_asset_count:0,exclusive_asset_ids:[],confirmation:''}:physicalImpact()};
  }
  if(command==='project_exclusive_scan') {
    if(w.holdRegistration) await new Promise(resolve=>{w.beginScan=resolve;});
    const result = new Promise(resolve=>{scans.set(args.requestId,{finish:resolve,cancelled:false});});
    w.sendScanProgress=(progress:any)=>args.onProgress.onmessage(progress);
    w.releaseScan=()=>{const scan=scans.get(args.requestId)!;scan.finish(scan.cancelled?null:physicalImpact());};
    w.sendScanProgress({phase:'assets',completed:1,total:4,remaining_ms:6000});
    if(!w.holdScan) w.releaseScan();
    const value=await result; scans.delete(args.requestId);
    if(w.failScan) throw 'synthetic scan failure';
    return value;
  }
  if(command==='cancel_project_exclusive_scan') {
    if(w.failCancel) throw 'synthetic stop failure';
    const scan=scans.get(args.requestId);
    if(scan) {scan.cancelled=true;if(!w.holdStop)scan.finish(null);}
    return;
  }
  if(command==='get_assets_by_ids') { if(w.failPreviews) throw 'synthetic preview failure'; return w.missingPreview ? w.assets.slice(1) : w.assets; }
  if(command==='delete_project') {
    if(w.failure) throw '项目素材或文件已变化，请重新打开删除确认';
    return {deleted_assets:3,preserved_shared:5,removed_members:8,moved_assets:w.transferred||0,failed_moves:[],cleanup_pending:w.pending?['synthetic cleanup failure']:[]};
  }
  return null;
}};
w.addEventListener('bowerbird://notify',(event:any)=>{w.notices.push(event.detail);document.getElementById('notice')!.textContent=event.detail.message;});
w.reset=()=>useStore.setState({projects:[{id:'p',name:'合成测试项目',kind:'blank'} as any],activeProjectId:null,reloadProjects:async()=>{}});
w.reset();
w.provisional=()=>useStore.setState({projects:[{id:'p',name:'未保存项目',provisional:true} as any]});
function Preview(){const {busy,prepareDelete,confirmation}=useProjectDeletion();return <main style={{padding:40}}><h1>项目删除 · 合成数据预览</h1><p>仅模拟 IPC，不连接真实资料。</p><button disabled={busy} className="app-modal-button" onClick={()=>prepareDelete('p')}>删除测试项目</button><div id="notice"/>{confirmation}</main>}
createRoot(document.getElementById('root')!).render(<Preview/>);
