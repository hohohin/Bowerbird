const WS_URL = "ws://127.0.0.1:39871/ws";
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 45000;

// content script 把候选交给 service worker；background 在浏览器会话内 fetch（自动走浏览器
// 系统代理 + Cookie / 登录态），再把真实图片字节经 WS save_blob 两帧协议上传桌面端。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "save_image") return false;
  fetchCandidate(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
  return true;
});

async function fetchCandidate(message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchAndUpload(
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
    if (error?.name === "AbortError") return { ok: false, error: "浏览器读取图片超时" };
    return { ok: false, error: readableError(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAndUpload(candidate, signal, visited, depth) {
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
  if (looksLikeImage(bytes, contentType)) {
    return uploadBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
      type: "save_blob",
      requested_url: candidate.url,
      effective_url: response.url || candidate.url,
      page_url: candidate.pageUrl || "",
      url: response.url || candidate.url, // 兼容旧桌面协议
      file_name: fileNameFromUrl(response.url || candidate.url),
      content_type: contentType,
      candidate_source: candidate.source,
    });
  }

  const looksHtml = claimsHtml || sniffHtml(bytes);
  if (looksHtml && depth === 0) {
    const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const fallback = extractPageImage(html, response.url || candidate.url);
    if (fallback) {
      return fetchAndUpload(
        { ...candidate, url: fallback, kind: "image-url", source: "html-metadata" },
        signal,
        visited,
        depth + 1
      );
    }
  }
  return { ok: false, error: "目标返回的不是可识别图片，页面也没有可用主图" };
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

function uploadBytes(bytes, metadata) {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return Promise.resolve({ ok: false, error: "图片超过 50 MiB 上限" });
  }
  return new Promise((resolve) => {
    let finished = false;
    let ws;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "桌面端接收图片超时" }), 60000);
    try {
      ws = new WebSocket(WS_URL);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => { ws.send(JSON.stringify(metadata)); ws.send(bytes); };
      ws.onmessage = (event) => {
        try { finish(JSON.parse(event.data)); }
        catch { finish({ ok: false, error: "桌面端返回了无法解析的响应" }); }
      };
      ws.onerror = () => finish({ ok: false, error: "无法连接 Bowerbird 桌面端" });
      ws.onclose = () => { if (!finished) finish({ ok: false, error: "桌面端在入库完成前关闭了连接" }); };
    } catch (error) {
      finish({ ok: false, error: readableError(error) });
    }
  });
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
