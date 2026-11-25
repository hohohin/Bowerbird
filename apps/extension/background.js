importScripts("pairing.js", "collection-utils.js", "video-utils.js", "image-batch.js", "preferences.js", "video-upload.js");
const S = globalThis.BowerbirdCollection;
const MAX_IMAGE_BYTES = S.MAX_IMAGE_BYTES;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = S.FETCH_TIMEOUT_MS;
const HEARTBEAT_INTERVAL_MS = 15000;
let nextHeartbeatAt = 0;
let heartbeatInFlight;
let lastHeartbeat;
let pairingCodeQueue = Promise.resolve();

function heartbeat() {
  const now = performance.now();
  if (!heartbeatInFlight && now >= nextHeartbeatAt) {
    nextHeartbeatAt = now + HEARTBEAT_INTERVAL_MS;
    heartbeatInFlight = S.checkVideoSupport()
      .catch(() => ({ ok: false }))
      .then(result => { lastHeartbeat = result; return result; })
      .finally(() => { heartbeatInFlight = undefined; });
  }
  const result = heartbeatInFlight || Promise.resolve(lastHeartbeat);
  return result.then(value => ({
    ...value,
    retryAfterMs: Math.max(1, Math.ceil(nextHeartbeatAt - performance.now())),
  }));
}

function pairingCode(rotate) {
  const pending = pairingCodeQueue.then(async () => {
    const key = (!rotate && await BowerbirdPairing.load()) || await BowerbirdPairing.generate();
    if (!key?.publicKey) throw new Error("missing public key");
    return { ok: true, code: `${chrome.runtime.id}.${key.publicKey}` };
  }).catch(() => ({ ok: false, code: "pair_required" }));
  pairingCodeQueue = pending.then(() => {});
  return pending;
}

// content script 把候选交给 service worker；background 在浏览器会话内 fetch（自动走浏览器
// 系统代理 + Cookie / 登录态），再把真实图片字节经 WS save_blob 两帧协议上传桌面端。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Only our own isolated content scripts may request a short-lived upload
  // proof. Take the origin from Chrome, never from message fields.
  if (message?.type === "collect_access") {
    if (_sender.id !== chrome.runtime.id || !_sender.tab || typeof _sender.origin !== "string") return false;
    const origin = _sender.origin;
    if (!/^(https?:\/\/|file:\/\/)/.test(origin) && origin !== "null") return false;
    BowerbirdPairing.proof(origin, "upload").then(sendResponse, () => sendResponse({ok:false,code:"pair_required"}));
    return true;
  }
  if (message?.type === "collect_heartbeat") {
    if (_sender.id !== chrome.runtime.id || !_sender.tab) return false;
    heartbeat().then(sendResponse);
    return true;
  }
  if (message?.type === "current_project") {
    if (_sender.id !== chrome.runtime.id) return false;
    S.currentProject().then(sendResponse, () => sendResponse({ok:false}));
    return true;
  }
  if (message?.type === "pairing_code_get" || message?.type === "pairing_code_rotate") {
    if (_sender.id !== chrome.runtime.id) return false;
    const rotate = message.type === "pairing_code_rotate";
    if (rotate && _sender.url !== chrome.runtime.getURL("options.html")) return false;
    pairingCode(rotate).then(sendResponse);
    return true;
  }
  if (!["save_image","save_video"].includes(message?.type)) return false;
  (message.type==="save_video" ? fetchVideo(message) : fetchCandidate(message))
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
  return true;
});
BowerbirdImageBatch.listen(fetchCandidateBytes);

async function fetchVideo(message) {
  const V=globalThis.BowerbirdVideo;
  const candidate=V.candidate(message.url,message.pageUrl,{source:message.candidateSource});
  if(!candidate || !/^https?:/.test(candidate.media_url)) return {ok:false,code:"invalid_video"};
  if(candidate.blocked) return {ok:false,code:candidate.blocked};
  const support=await S.checkVideoSupport();
  if(!support.ok) return support;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),S.VIDEO_FETCH_TIMEOUT_MS);
  try {
    const response=await fetch(candidate.media_url,{credentials:"include",referrer:message.pageUrl || undefined,signal:controller.signal});
    if(response.status===206) return {ok:false,code:"incomplete_video"};
    if(!response.ok) return {ok:false,code:"fetch_failed"};
    const contentType=response.headers.get("content-type") || "";
    if(/mpegurl|dash\+xml/i.test(contentType)) return {ok:false,code:"unsupported_stream"};
    if(/text\/html|application\/json/i.test(contentType)) return {ok:false,code:"invalid_video"};
    const metadata={media_kind:"video",requested_url:candidate.media_url,effective_url:response.url || candidate.media_url,
      page_url:message.pageUrl || "",url:response.url || candidate.media_url,content_type:contentType,candidate_source:candidate.candidate_source};
    if (support.streamUpload) {
      return await BowerbirdVideoUpload.streamResponse(response, support, metadata, controller.signal, () => clearTimeout(timer));
    }
    const bytes=await V.read(response,support.maxBytes);
    if(V.stream(bytes)) return {ok:false,code:"unsupported_stream"};
    const ext=V.format(bytes);
    if(!ext) return {ok:false,code:"invalid_video"};
    clearTimeout(timer);
    return S.uploadBytes(bytes.buffer,{...metadata,file_name:`video.${ext}`});
  } catch(error) {return {ok:false,code:error?.code || (error?.name==="AbortError" ? "fetch_timeout" : "fetch_failed")};}
  finally {clearTimeout(timer);}
}

async function fetchCandidate(message) {
  const candidate = await fetchCandidateBytes(message);
  return candidate.ok ? S.uploadBytes(candidate.bytes, candidate.metadata) : candidate;
}

async function fetchCandidateBytes(message, signal) {
  if (signal?.aborted) return { ok: false, code: "cancelled" };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let result;
  try {
    result = await readCandidate(
      {
        url: message.url,
        pageUrl: message.pageUrl || "",
        kind: message.candidateKind || "image-url",
        source: message.candidateSource || "unknown",
      },
      controller.signal,
      new Set(),
      0
    );
  } catch (error) {
    result = { ok: false, error: readableError(error) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
  if (signal?.aborted) return { ok: false, code: "cancelled" };
  if (controller.signal.aborted) return { ok: false, code: "fetch_timeout", error: "浏览器读取图片超时" };
  return result;
}

async function readCandidate(candidate, signal, visited, depth) {
  if (!/^https?:\/\//.test(candidate.url || "")) {
    return { ok: false, error: "图片地址不是 HTTP(S) URL" };
  }
  if (visited.has(candidate.url)) return { ok: false, error: "页面图片跳转形成循环" };
  visited.add(candidate.url);

  let response;
  try {
    response = await fetch(candidate.url, {
      credentials: "include",
      cache: "force-cache",
      referrer: candidate.pageUrl || undefined,
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") return { ok: false, code: "fetch_timeout", error: "浏览器读取图片超时" };
    return { ok: false, error: `浏览器读取失败：${readableError(error)}` };
  }
  if (!response.ok) return { ok: false, error: `浏览器读取失败：HTTP ${response.status}` };

  const contentType = response.headers.get("content-type") || "";
  const claimsHtml = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
  const contentLength = Number(response.headers.get("content-length") || 0);
  const limit = claimsHtml ? MAX_HTML_BYTES : MAX_IMAGE_BYTES;
  if (contentLength > limit) {
    return { ok: false, error: `目标内容超过 ${Math.round(limit / 1024 / 1024)} MiB 上限` };
  }

  let bytes;
  try {
    bytes = await readResponseLimited(response, limit);
  } catch (error) {
    return { ok: false, error: readableError(error) };
  }
  if (bytes.byteLength === 0) return { ok: false, error: "浏览器读取到的内容为空" };

  // 字节 magic 优先：服务器 MIME 写错但真实是图片时照常上传。
  const bmff = BowerbirdVideo.bmffImageFormat(bytes);
  if (bmff || looksLikeImage(bytes, contentType)) {
    const effectiveUrl = response.url || candidate.url;
    let fileName = fileNameFromUrl(effectiveUrl);
    let uploadedType = contentType;
    if (bmff === "avif") {
      // The desktop image ingest supports PNG. Chromium can decode AVIF into its first frame.
      const normalized = await avifToPng(bytes, signal);
      if (!normalized.ok) return normalized;
      bytes = normalized.bytes;
      uploadedType = "image/png";
      fileName = `${fileName.replace(/\.[^.]+$/, "")}.png`;
    }
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return { ok: true, bytes: buffer, metadata: {
      type: "save_blob",
      requested_url: candidate.url,
      effective_url: effectiveUrl,
      page_url: candidate.pageUrl || "",
      url: effectiveUrl, // 兼容旧桌面协议
      file_name: fileName,
      content_type: uploadedType,
      candidate_source: candidate.source,
    } };
  }

  const looksHtml = claimsHtml || sniffHtml(bytes);
  if (looksHtml && depth === 0) {
    const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const fallback = extractPageImage(html, response.url || candidate.url);
    if (fallback) {
      return readCandidate(
        { ...candidate, url: fallback, kind: "image-url", source: "html-metadata" },
        signal,
        visited,
        depth + 1
      );
    }
  }
  return { ok: false, error: "目标返回的不是可识别图片，页面也没有可用主图" };
}

async function avifToPng(bytes, signal) {
  let bitmap;
  try {
    signal.throwIfAborted();
    bitmap = await createImageBitmap(new Blob([bytes], { type: "image/avif" }));
    signal.throwIfAborted();
    const { width, height } = bitmap;
    if (width > 32768 || height > 32768 || width * height > 100000000) return { ok: false, code: "image_dimensions" };
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const png = await canvas.convertToBlob({ type: "image/png" });
    signal.throwIfAborted();
    if (png.size > MAX_IMAGE_BYTES) return { ok: false, code: "too_large" };
    return { ok: true, bytes: new Uint8Array(await png.arrayBuffer()) };
  } catch (error) {
    if (signal.aborted) throw error;
    return { ok: false, code: "invalid_image" };
  } finally {
    bitmap?.close();
  }
}

async function readResponseLimited(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error("响应超过大小上限");
    return bytes;
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("响应超过大小上限");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function looksLikeImage(bytes, contentType) {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b.length >= 6 && String.fromCharCode(...b.slice(0, 6)).startsWith("GIF8")) return true;
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return true;
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return true; // BMP
  const start = new TextDecoder("utf-8", { fatal: false }).decode(b.slice(0, 512)).trimStart();
  if (/^<\?xml[^>]*>\s*<svg|^<svg/i.test(start)) return true;
  return /^image\//i.test(contentType) && !sniffHtml(bytes);
}

function sniffHtml(bytes) {
  const start = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 1024))
    .trimStart()
    .toLowerCase();
  return start.startsWith("<!doctype html") || start.startsWith("<html") || start.includes("<head");
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.slice(start, end));
}

function extractPageImage(html, base) {
  const tags = String(html || "").match(/<(?:meta|link)\b[^>]*>/gi) || [];
  const wantedMeta = new Set(["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]);
  const attr = (tag, name) => {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").replace(/&amp;/gi, "&");
  };
  for (const tag of tags) {
    const key = (attr(tag, "property") || attr(tag, "name")).toLowerCase();
    const rel = attr(tag, "rel").toLowerCase();
    if (!wantedMeta.has(key) && rel !== "image_src") continue;
    const value = attr(tag, "content") || attr(tag, "href");
    try {
      const url = new URL(value, base);
      if (/^https?:$/.test(url.protocol)) return url.href;
    } catch { /* skip malformed metadata */ }
  }
  return null;
}

function fileNameFromUrl(url) {
  try {
    const name = new URL(url).pathname.split("/").pop();
    return decodeURIComponent(name || "extension-image");
  } catch { return "extension-image"; }
}

function readableError(error) {
  return error instanceof Error ? error.message : String(error);
}
