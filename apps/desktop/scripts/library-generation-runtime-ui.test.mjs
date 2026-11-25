import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/library-generation-runtime-vite', optimizeDeps: { entries: [] }, server: {host:'127.0.0.1',port:1589,strictPort:true,hmr:false,watch:null} });
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage();
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
try {
  await page.route('**/runtime-test',route=>route.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
  await page.goto(`${server.resolvedUrls.local[0]}runtime-test`);
  const result = await page.evaluate(async () => {
    const [{useStore},{useLocalChatStore},runtime] = await Promise.all([
      import('/src/store.ts'),import('/src/lib/localChatStore.ts'),import('/src/lib/libraryGenerationRuntime.ts'),
    ]);
    const notices=[]; window.addEventListener('bowerbird://notify',event=>notices.push(event.detail));
    useStore.setState({projects:[{id:'p',name:'快速生成'}],settings:{generation_completion_popup:true,generation_completion_sound:false},projectUnreadThreads:{}});
    const stopChat=runtime.observeLibraryChatCompletion();
    const chat={id:'chat',projectId:'p',threadId:'ct',nodeId:'cn',title:'聊天',status:'idle',revision:1,turnCount:1,updatedAt:1};
    useLocalChatStore.setState({summaries:{chat}});
    const historyNotices=notices.length;
    useLocalChatStore.setState({summaries:{chat:{...chat,status:'running',revision:2}}});
    useLocalChatStore.setState({summaries:{chat:{...chat,status:'idle',revision:3}}});
    useLocalChatStore.setState({summaries:{chat:{...chat,status:'idle',revision:4}}});
    await Promise.resolve();
    const chatNotices=notices.length;
    notices[0].action.onClick();
    const chatLocation=useStore.getState().creativeNavigation;
    stopChat();
    return {historyNotices,chatNotices,chatLocation,unread:useStore.getState().projectUnreadThreads};
  });
  assert.equal(result.historyNotices,0,'loading completed chat history is silent');
  assert.equal(result.chatNotices,1,'only fresh running→idle transition notifies');
  assert.deepEqual(result.chatLocation,{projectId:'p',threadId:'ct',nodeId:'cn'});
  assert.deepEqual(result.unread.p,['ct']);
  assert.deepEqual(errors,[]);
  console.log('PASS chat runtime: fresh completion only, no duplicate/history notice, exact navigation');
} finally {await browser.close();await server.close();}
