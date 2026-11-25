import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
function runtime() {
  const context = vm.createContext({URL,TextDecoder,Uint8Array,ArrayBuffer});
  vm.runInContext(readFileSync(new URL("video-utils.js",import.meta.url),"utf8"),context);
  return context.BowerbirdVideo;
}
test("video candidates keep the source page and reject page links and streaming playlists", () => {
  const V=runtime();
  const value=V.candidate("/movie.mp4","https://site.test/note",{source:"video",name:"片段"});
  assert.equal(value.media_url,"https://site.test/movie.mp4");
  assert.equal(value.source_url,"https://site.test/note");
  assert.equal(value.media_kind,"video");
  assert.equal(V.candidate("https://site.test/stream.m3u8","https://site.test/note").blocked,"unsupported_stream");
  assert.equal(V.candidate("https://site.test/player.mpd","https://site.test/note").blocked,"unsupported_stream");
  assert.equal(V.candidate("javascript:alert(1)","https://site.test/note"),null);
  assert.equal(V.candidate("blob:https://site.test/id","https://site.test/note").media_kind,"video");
});
test("video byte checks reject HTML and images even when their MIME says video", () => {
  const V=runtime();
  const bytes=Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0]);
  assert.equal(V.format(bytes),"mp4");
  assert.equal(V.format(new TextEncoder().encode("<!doctype html><html>login</html>")),null);
  assert.equal(V.format(Uint8Array.from([137,80,78,71,13,10,26,10])),null);
  assert.equal(V.format(Uint8Array.from([0,0,0,24,102,116,121,112,97,118,105,102,0,0,0,0])),null);
  assert.equal(V.format(Uint8Array.from([26,69,223,163,0,0,0,0])),"webm");
});
test("video streams are size bounded without Content-Length and selected XHS URLs are retained",async()=>{
  const V=runtime();let cancelled=false;
  const response={headers:{get:()=>null},body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(9)}),cancel:async()=>{cancelled=true;}})}};
  await assert.rejects(V.read(response,8),error=>error.code==="too_large");assert.equal(cancelled,true);
  const item=V.xhs({type:"video",title:"笔记",video:{media:{stream:{h264:[{masterUrl:"https://cdn.test/a.mp4"}]}}}},"https://www.xiaohongshu.com/explore/id");
  assert.equal(item.media_url,"https://cdn.test/a.mp4");assert.equal(item.source_url,"https://www.xiaohongshu.com/explore/id");
  assert.equal(V.xhs({type:"normal",imageList:[]},"https://site.test/"),null);
});

test("video streaming cancels the response when declined before reading", async () => {
  let sessions = 0;
  const socket = {
    send() { queueMicrotask(() => this.onmessage({ data: '{"capabilities":{"video_blob":true}}' })); },
    close() {},
  };
  const context = vm.createContext({
    setTimeout, clearTimeout,
    BowerbirdCollection: {
      UPLOAD_TIMEOUT_MS: 1000,
      socketAccess: async () => { sessions += 1; return { ok: true }; },
      openSocket: () => { queueMicrotask(() => socket.onopen()); return socket; },
      pingMessage: () => '{"type":"ping"}',
    },
  });
  vm.runInContext(readFileSync(new URL("video-upload.js", import.meta.url), "utf8"), context);
  const { streamResponse } = context.BowerbirdVideoUpload;
  for (const [length, expected] of [[10, "too_large"], [4, "desktop_upgrade"]]) {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const result = await streamResponse(new Response(body, { headers: { "content-length": length } }), { maxBytes: 8 });
    assert.equal(result.code, expected);
    assert.equal(cancelled, true);
  }
  assert.equal(sessions, 1);
});
