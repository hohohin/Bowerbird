import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react';
import { listenForNotices, type NoticeDetail } from '../../../src/lib/notify';
import { notifyGenerationComplete } from '../../../src/lib/generationNotifications';
import type { AppSettings } from '../../../src/lib/types';
import type { GenerationNotice } from './NotificationBell';
let previewNoticeId = 0;
let generationEmission = false;
// Register before React's subscribers. This bridge exists only until the explicit
// channel is added to the producer after the preview is approved.
window.addEventListener('bowerbird://notify', event => {
  if (generationEmission) (event as CustomEvent<GenerationNotice>).detail.channel = 'generation';
}, true);

/** Only this isolated fixture adds the pending explicit channel to the real producer. */
export async function emitPreviewGenerationNotice({ key, message = '图片生成完成，已生成 2 张图片', projectName = '快速生成', onOpen = () => {}, settings }: {
  key?: string; message?: string; projectName?: string; onOpen?: () => void; settings?: Pick<AppSettings, 'generation_completion_popup' | 'generation_completion_sound'>;
} = {}) {
  generationEmission = true;
  try { return notifyGenerationComplete(key ?? `preview:${++previewNoticeId}`, message,
    (settings ?? { generation_completion_popup: true, generation_completion_sound: false }) as AppSettings,
    { projectName, onOpen }); }
  finally { generationEmission = false; }
}

function PreviewToast({ notice, dismiss }: { notice: NoticeDetail; dismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => { if (paused) return; const timer=window.setTimeout(()=>dismiss(notice.id),4200);return()=>window.clearTimeout(timer); },[notice.id,paused]);
  const Icon=notice.tone==='success'?CheckCircle2:notice.tone==='error'?CircleAlert:Info;
  return <div className={`app-toast is-${notice.tone}`} role="status" onMouseEnter={()=>setPaused(true)} onMouseLeave={()=>setPaused(false)}
    onFocus={()=>setPaused(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setPaused(false);}}>
    <Icon size={17}/><span>{notice.message}</span><button type="button" aria-label="关闭通知" onClick={()=>dismiss(notice.id)}><X size={14}/></button>
  </div>;
}

export function PreviewToastViewport() {
  const [notices,setNotices]=useState<NoticeDetail[]>([]);
  useEffect(()=>listenForNotices(notice=>{
    if((notice as GenerationNotice).channel!=='generation')setNotices(current=>[...current.slice(-2),notice]);
  }),[]);
  return <div className="toast-viewport" aria-live="polite">{notices.map(notice=><PreviewToast key={notice.id} notice={notice} dismiss={id=>setNotices(current=>current.filter(item=>item.id!==id))}/>)}</div>;
}
