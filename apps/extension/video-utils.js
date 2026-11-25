(function (root) {
  "use strict";
  const MAX_BYTES = 200 * 1024 * 1024;
  const AVIF_BRANDS = new Set(["avif", "avis"]);
  const HEIC_BRANDS = new Set(["heic", "heix", "heif", "heim", "heis", "mif1", "msf1"]);
  const ascii = (bytes, start, end) => String.fromCharCode(...bytes.subarray(start, end));

  function bmffImageFormat(bytes) {
    if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let size = view.getUint32(0);
    const brandOffset = size === 1 ? 16 : 8;
    if (bytes.length < brandOffset + 8) return null;
    if (size === 1) size = Number(view.getBigUint64(8));
    if (size !== 0 && size < brandOffset + 8) return null;
    const major = ascii(bytes, brandOffset, brandOffset + 4);
    if (AVIF_BRANDS.has(major)) return "avif";
    let heic = HEIC_BRANDS.has(major);
    const end = Math.min(size || bytes.length, bytes.length, 4096);
    for (let offset = brandOffset + 8; offset + 4 <= end; offset += 4) {
      const brand = ascii(bytes, offset, offset + 4);
      if (AVIF_BRANDS.has(brand)) return "avif";
      if (HEIC_BRANDS.has(brand)) heic = true;
    }
    return heic ? "heic" : null;
  }
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
    if (b.length >= 12 && ascii(b,4,8) === "ftyp") {
      const brand = ascii(b,8,12);
      if (bmffImageFormat(b) || AVIF_BRANDS.has(brand) || HEIC_BRANDS.has(brand)) return null;
      return ascii(b,8,12) === "qt  " ? "mov" : "mp4";
    }
    if (b.length >= 4 && b[0]===26 && b[1]===69 && b[2]===223 && b[3]===163) return "webm";
    if (b.length >= 12 && ascii(b,0,4)==="RIFF" && ascii(b,8,12)==="AVI ") return "avi";
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
  root.BowerbirdVideo = { MAX_BYTES,candidate,format,bmffImageFormat,stream,read,element,xhs };
})(globalThis);
