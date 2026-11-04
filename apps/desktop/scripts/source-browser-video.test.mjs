import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const script = await readFile(process.env.BOWERBIRD_SOURCE_VIDEO_PATH || 'src-tauri/src/commands/source_browser_video.js', 'utf8');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function pageFor(url = 'https://www.xiaohongshu.com/explore/note-a') {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.addInitScript(script);
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<video id="target"></video><video id="other"></video>' }));
  await page.goto(url);
  return page;
}
try {
  const anonymous = await pageFor('https://www.pinterest.com/pin/123456789/');
  const manifestUrl = 'https://v1.pinimg.com/videos/fixture/index.m3u8';
  await anonymous.route(manifestUrl, route => route.fulfill({headers:{'content-type':'application/vnd.apple.mpegurl','access-control-allow-origin':'https://www.pinterest.com','access-control-allow-credentials':'false'},body:'#EXTM3U\n#EXT-X-ENDLIST'}));
  assert.deepEqual(await anonymous.evaluate(url => window.__bbSourceVideo.manifestBase(url,'anonymous-manifest',false), manifestUrl), {type:'cors',ok:true}, 'Pinterest public CDN allows only credential-free CORS reads');
  assert.deepEqual(await anonymous.evaluate(url => window.__bbSourceVideo.manifestBase(url,'credentialed-manifest'), manifestUrl), {type:'unknown'}, 'the default remains credentialed for other capture requests');
  await anonymous.close();
  console.log('source video: anonymous Pinterest manifest and credentialed default passed');
  const blob = await pageFor();
  assert.equal(await blob.evaluate(() => typeof window.__bbSourceVideo?.open), 'function', 'the source renderer exposes bounded reading to native code');
  const result = await blob.evaluate(async () => {
    const bytes = Uint8Array.from({length: 180000}, (_, i) => i % 251);
    const source = URL.createObjectURL(new Blob([bytes], {type:'video/mp4'}));
    target.src = source;
    window.__bbSourceVideo.remember(target, source, location.href);
    const resolved = await window.__bbSourceVideo.resolve(source, location.href);
    const opened = await window.__bbSourceVideo.open(resolved, 200000);
    const output = []; let largest = 0;
    for (;;) {
      const chunk = await window.__bbSourceVideo.read(opened.id);
      const value = Uint8Array.from(atob(chunk.data), c => c.charCodeAt(0));
      output.push(...value); largest = Math.max(largest, value.length);
      if (chunk.eof) break;
    }
    await window.__bbSourceVideo.close(opened.id);
    return { equal: output.every((v,i) => v === bytes[i]) && output.length === bytes.length, largest, mime:opened.contentType };
  });
  assert.equal(result.equal, true); assert.ok(result.largest <= 65536); assert.equal(result.mime, 'video/mp4');
  assert.match(await blob.evaluate(async () => {
    try { await window.__bbSourceVideo.open(target.src, 10); return ''; } catch (e) { return e.message; }
  }), /大小/);
  const compressed = gzipSync(Buffer.alloc(8192, 42));
  // CDP fulfillment supplies decoded bytes with original transport headers;
  // the native suite additionally verifies a real gzip HTTP response.
  await blob.route('**/gzip.mp4', route => route.fulfill({headers:{'content-type':'video/mp4','content-encoding':'gzip','content-length':String(compressed.length)},body:Buffer.alloc(8192,42)}));
  assert.deepEqual(await blob.evaluate(async () => {
    const opened = await window.__bbSourceVideo.open(new URL('/gzip.mp4',location.href).href,10000);
    let length=0; for(;;) {const part=await window.__bbSourceVideo.read(opened.id);length+=atob(part.data).length;if(part.eof)break;}
    return {length,total:opened.totalBytes};
  }),{length:8192,total:null},'compressed transport size is not the decoded body length');
  await blob.close();
  console.log('source video: actual Blob bytes, bounded chunks and size rejection passed');

  const xhs = await pageFor();
  assert.equal(await xhs.evaluate(async () => {
    const source = URL.createObjectURL(new MediaSource()); target.src = source;
    window.__INITIAL_STATE__ = { note: { noteDetailMap: {
      'note-b': {note:{noteId:'note-b',type:'video',video:{url:'https://cdn.example/wrong.mp4'}}},
      'note-a': {note:{noteId:'note-a',type:'video',video:{media:{stream:{h264:[{masterUrl:'https://cdn.example/right.mp4'}]}}}}}
    }}};
    window.__bbSourceVideo.remember(target, source, location.href);
    return window.__bbSourceVideo.resolve(source, location.href);
  }), 'https://cdn.example/right.mp4');
  assert.match(await xhs.evaluate(async () => {
    window.__INITIAL_STATE__ = {note:{noteDetailMap:{'note-a':{note:{noteId:'note-a',type:'video',video:{}}}}}};
    try { return await window.__bbSourceVideo.resolve(target.src, location.href); } catch (error) { return error.message; }
  }), /尚未找到/, 'missing video fields never turn into a relative /undefined URL');
  assert.match(await xhs.evaluate(async () => {
    history.pushState({}, '', '/explore/note-b');
    try { return await window.__bbSourceVideo.resolve(target.src, 'https://www.xiaohongshu.com/explore/note-a'); } catch (e) { return e.message; }
  }), /切换/);
  await xhs.close();
  console.log('source video: matching Xiaohongshu note and stale document rejection passed');

  const pin = await pageFor('https://www.pinterest.com/pin/123456789/');
  assert.equal(await pin.evaluate(async () => {
    const source = URL.createObjectURL(new MediaSource()); target.src = source;
    window.__PWS_DATA__ = {props:{initialReduxState:{pins:{
      '987654321':{id:'987654321',videos:{video_list:{V_720P:{url:'https://cdn.example/wrong.mp4'}}}},
      '123456789':{id:'123456789',videos:{video_list:{V_HLSV4:{url:'https://cdn.example/right.m3u8'}}}}
    }}}};
    window.__bbSourceVideo.remember(target, source, location.href);
    return window.__bbSourceVideo.resolve(source, location.href);
  }), 'https://cdn.example/right.m3u8');
  await pin.close();
  console.log('source video: matching Pinterest pin manifest passed');

  const mse = await pageFor('https://example.com/watch');
  const media = await readFile('src-tauri/tests/fixtures/media/fragmented.mp4');
  await mse.route('**/clip.m3u8', route => route.fulfill({contentType:'application/vnd.apple.mpegurl', body:'#EXTM3U\n#EXTINF:4,\nclip.mp4\n#EXT-X-ENDLIST\n'}));
  await mse.route('**/unrelated.m3u8', route => route.fulfill({contentType:'application/vnd.apple.mpegurl', body:'#EXTM3U\n#EXTINF:4,\nwrong.mp4\n#EXT-X-ENDLIST\n'}));
  await mse.route('**/clip.mp4', route => route.fulfill({contentType:'video/mp4', body:media}));
  const resolved = await mse.evaluate(async () => {
    await (await fetch('/clip.m3u8')).text();
    await (await fetch('/unrelated.m3u8')).text();
    const ms = new MediaSource(); const source = URL.createObjectURL(ms); target.src = source;
    await new Promise(resolve => ms.addEventListener('sourceopen', resolve, {once:true}));
    const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.64001E"');
    const bytes = await (await fetch('/clip.mp4')).arrayBuffer();
    sb.appendBuffer(bytes);
    await new Promise(resolve => sb.addEventListener('updateend', resolve, {once:true}));
    history.pushState({}, '', '/watch/playing');
    window.__bbSourceVideo.remember(target, source, location.href);
    return window.__bbSourceVideo.resolve(source, location.href);
  });
  assert.equal(resolved, 'https://example.com/clip.m3u8', 'the appended segment links its MSE across SPA navigation, never the last manifest on the page');
  await mse.route('**/ambiguous.m3u8', route => route.fulfill({contentType:'application/vnd.apple.mpegurl',body:'#EXTM3U\n#EXTINF:4,\nclip.mp4\n#EXT-X-ENDLIST\n'}));
  assert.match(await mse.evaluate(async () => {
    await (await fetch('/ambiguous.m3u8')).text();
    try { return await window.__bbSourceVideo.resolve(target.src, location.href); } catch (e) { return e.message; }
  }), /确认/);
  await mse.close();
  console.log('source video: actual MediaSource association and ambiguous manifest rejection passed');
} finally { await browser.close(); }
