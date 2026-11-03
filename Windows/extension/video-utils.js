(function (root) {
  "use strict";
  const MAX_BYTES = 200 * 1024 * 1024;
  function candidate(raw, pageUrl, options = {}) {
    if (!raw || String(raw).length > (/^data:video\//i.test(raw) ? Math.ceil(MAX_BYTES*4/3)+4096 : 16384)) return null;
    let url;
    try { url = new URL(raw,pageUrl); } catch { return null; }
    if (!["http:","https:","blob:","data:"].includes(url.protocol) || url.username || url.password) return null;
    if (url.protocol === "data:" && !/^data:video\//i.test(raw)) return null;
    const blocked = /\.(m3u8|mpd)(?:$|[?#])/i.test(url.href) ? "unsupported_stream" : options.blocked;
    return {media_url:url.href,source_url:pageUrl,media_kind:"video",candidate_source:options.source || "video",
      name:options.name || "视频",duration:Number.isFinite(options.duration) ? options.duration : 0,poster:options.poster || "",blocked};
  }
  function format(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const ascii = (start,end) => String.fromCharCode(...b.slice(start,end));
    if (b.length >= 12 && ascii(4,8) === "ftyp") {
      if (["avif","avis","heic","heix","heim","heis","mif1","msf1"].includes(ascii(8,12))) return null;
      return ascii(8,12) === "qt  " ? "mov" : "mp4";
    }
    if (b.length >= 4 && b[0]===26 && b[1]===69 && b[2]===223 && b[3]===163) return "webm";
    if (b.length >= 12 && ascii(0,4)==="RIFF" && ascii(8,12)==="AVI ") return "avi";
    return null;
  }
  function stream(bytes) {
    const text=new TextDecoder().decode(bytes.slice(0,1024)).trimStart();
    return /^#EXTM3U/.test(text) || /^(?:<\?xml[^>]*>\s*)?<MPD(?:\s|>)/i.test(text);
  }
  async function read(response,limit = MAX_BYTES) {
    if (Number(response.headers.get("content-length")) > limit) throw Object.assign(new Error("视频超过大小限制"),{code:"too_large"});
    const reader = response.body?.getReader();
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if(bytes.byteLength > limit) throw Object.assign(new Error("视频超过大小限制"),{code:"too_large"});
      return bytes;
    }
    const chunks=[]; let size=0;
    while(true) {
      const {done,value}=await reader.read(); if(done) break;
      size+=value.byteLength;
      if(size>limit) {await reader.cancel();throw Object.assign(new Error("视频超过大小限制"),{code:"too_large"});}
      chunks.push(value);
    }
    const bytes=new Uint8Array(size); let offset=0;
    for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
    return bytes;
  }
  function element(video,pageUrl) {
    const options={source:"video-element",name:video.getAttribute("title") || video.getAttribute("aria-label") || "页面视频",
      poster:video.poster,duration:video.duration,blocked:video.mediaKeys ? "protected_video" : undefined};
    const urls=[video.currentSrc,video.getAttribute("src"),...Array.from(video.querySelectorAll("source[src]"),s=>s.src || s.getAttribute("src"))];
    const values=urls.map(url=>candidate(url,pageUrl,options)).filter(Boolean);
    return values.find(value=>!value.blocked && /^https?:/.test(value.media_url)) || values.find(value=>!value.blocked) || values[0] || null;
  }
  function xhs(note,pageUrl) {
    if(note?.type!=="video") return null;
    const streams=note.video?.media?.stream || {};
    const variants=[streams.h264,streams.h265,streams.av1].flatMap(value=>Array.isArray(value) ? value : []);
    const urls=[...variants.map(item=>item.masterUrl || item.master_url || item.url),note.video?.url,note.video?.playUrl];
    return urls.map(url=>candidate(url,pageUrl,{source:"xhs-video",name:note.title || "小红书视频"})).find(Boolean) || null;
  }
  root.BowerbirdVideo = { MAX_BYTES,candidate,format,stream,read,element,xhs };
})(globalThis);
