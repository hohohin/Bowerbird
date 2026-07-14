const WS_URL = "ws://127.0.0.1:39871/ws";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "save_image") return false;
  fetchAndUpload(message.url, message.pageUrl)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
  return true;
});

async function fetchAndUpload(url, pageUrl) {
  if (!/^https?:\/\//.test(url || "")) return { ok: false, error: "图片地址不是 HTTP(S) URL" };
  let response;
  try {
    response = await fetch(url, { credentials: "include", cache: "force-cache", referrer: pageUrl || undefined });
  } catch (error) {
    return { ok: false, error: `浏览器读取图片失败：${readableError(error)}` };
  }
  if (!response.ok) return { ok: false, error: `浏览器读取图片失败：HTTP ${response.status}` };
  const contentType = response.headers.get("content-type") || "";
  if (contentType && !/^image\//i.test(contentType) && !/^application\/octet-stream/i.test(contentType)) {
    return { ok: false, error: `目标返回的不是图片：${contentType}` };
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) return { ok: false, error: "浏览器读取到的图片为空" };
  return uploadBytes(bytes, {
    type: "save_blob", url, page_url: pageUrl || "",
    file_name: fileNameFromUrl(response.url || url),
    content_type: contentType,
  });
}

function uploadBytes(bytes, metadata) {
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
