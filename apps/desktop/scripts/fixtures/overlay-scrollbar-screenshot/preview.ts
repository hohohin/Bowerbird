import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
const w = window as any;
w.calls=[];
const image=document.createElement('canvas');image.width=320;image.height=240;
const ctx=image.getContext('2d')!;ctx.fillStyle='#253a4b';ctx.fillRect(0,0,320,240);
const bytes=await (await new Promise<Blob>(resolve=>image.toBlob(blob=>resolve(blob!)))).arrayBuffer();
mockWindows('snip-fixture');
mockIPC(async(command,args)=>{
  w.calls.push({command,args});
  if(command==='screenshot_session')return 'synthetic-session';
  if(command==='screenshot_image'||command==='screenshot_history_image')return bytes;
  if(command==='screenshot_history_list')return Array.from({length:24},(_,index)=>({id:`synthetic-${index}`,created_at:'2026-11-03T08:00:00Z',width:320,height:240,bytes:bytes.byteLength}));
  return null;
},{shouldMockEvents:true});
await import('../../../src/screenshot-main');
