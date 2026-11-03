import { createRoot } from 'react-dom/client';
import { NotificationBell } from './NotificationBell';
import { emitPreviewGenerationNotice, PreviewToastViewport } from './notification-preview';
import { notify } from '../../../src/lib/notify';
import { useStore } from '../../../src/store';
import '../../../src/styles.css';
import '../../../src/components/IndustrialTheme.css';
const w = window as any;
document.documentElement.dataset.theme='dark';
w.opened=[];
const job=(id:string,running:boolean)=>({id,projectId:'quick',threadId:`thread-${id}`,running,createdAt:Date.now(),lastPrompt:id,
  turns:[{id:1,turnKey:`turn-${id}`,prompt:id,images:running?[]:['out.png']}]});
useStore.setState({projects:[{id:'quick',name:'快速生成'}] as any,genJobs:{'山野海报':job('山野海报',true),'秋日图册':job('秋日图册',false)} as any,cloudAgentRuns:{},projectUnreadThreads:{quick:['thread-秋日图册']}});
w.notice=(message='图片生成完成',options={})=>emitPreviewGenerationNotice({message,onOpen:()=>w.opened.push(message),...options});
w.notify=notify;
w.navigation=()=>useStore.getState().creativeNavigation;
createRoot(document.getElementById('root')!).render(<>
  <header style={{height:44,display:'flex',justifyContent:'flex-end',alignItems:'center',gap:8,paddingRight:20}}>
    <NotificationBell/><button>1,280 Bcoin</button>
  </header><main style={{padding:20}}><button id="outside">素材库</button></main><PreviewToastViewport/>
</>);
