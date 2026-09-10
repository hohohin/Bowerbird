import React from 'react';
import {createRoot} from 'react-dom/client';
import {useProjectDeletion} from '../../../src/components/useProjectDeletion';
import {useStore} from '../../../src/store';
import '../../../src/styles.css';
const w=window as any;
w.calls=[]; w.notices=[]; w.failure=false; w.running=0; w.pending=false;
w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
  w.calls.push({command,args});
  if(command==='project_delete_impact') return {project_asset_count:8,thread_count:2,node_count:13,running_generation_count:w.running,running_agent_count:0,physical:{exclusive_asset_count:3,exclusive_file_count:6,preserved_shared_count:4,preserved_unsafe_count:1,confirmation:'test-confirmation'}};
  if(command==='delete_project') {
    if(w.failure) throw '项目素材或文件已变化，请重新打开删除确认';
    return {deleted_assets:3,preserved_shared:5,removed_members:8,moved_assets:0,failed_moves:[],cleanup_pending:w.pending?['synthetic cleanup failure']:[]};
  }
  return null;
}};
w.addEventListener('bowerbird://notify',(event:any)=>{w.notices.push(event.detail);document.getElementById('notice')!.textContent=event.detail.message;});
w.reset=()=>useStore.setState({projects:[{id:'p',name:'合成测试项目',kind:'blank'} as any],activeProjectId:null,reloadProjects:async()=>{}});
w.reset();
w.provisional=()=>useStore.setState({projects:[{id:'p',name:'未保存项目',provisional:true} as any]});
function Preview(){const {busy,prepareDelete,confirmation}=useProjectDeletion();return <main style={{padding:40}}><h1>项目删除 · 合成数据预览</h1><p>仅模拟 IPC，不连接真实资料。</p><button disabled={busy} className="app-modal-button" onClick={()=>prepareDelete('p')}>删除测试项目</button><div id="notice"/>{confirmation}</main>}
createRoot(document.getElementById('root')!).render(<Preview/>);
