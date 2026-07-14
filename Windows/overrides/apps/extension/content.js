// Bowerbird content script：悬浮按钮支持 ①拖拽图片投放采集 ②点击→二次确认批量采集本页 ③Alt+点击图片单张保存。
// 与 background.js 通过 chrome.runtime.sendMessage 通信。

(function () {
  if (window.__bowerbirdInjected) return;
  window.__bowerbirdInjected = true;

  const WS_URL = "ws://127.0.0.1:39871/ws";

  // 让桌面端可见扩展已安装且当前浏览器可连接；不影响采集请求。
  function heartbeat() {
    try {
      const ws = new WebSocket(WS_URL);
      const timer = setTimeout(() => ws.close(), 3000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "ping" }));
      ws.onmessage = () => { clearTimeout(timer); ws.close(); };
      ws.onerror = () => { clearTimeout(timer); };
    } catch { /* 桌面端未启动时静默，采集时再给出明确提示 */ }
  }
  heartbeat();
  setInterval(heartbeat, 15000);

  // ---- 悬浮按钮：拖拽图片到此处采集 / 点击 → 二次确认批量采集本页 ----
  const btn = document.createElement("div");
  const btnLogo = document.createElement("img");
  btnLogo.src = chrome.runtime.getURL("icons/48x48.png");
  btnLogo.alt = "";
  btnLogo.style.cssText = "width:100%;height:100%;display:block;pointer-events:none";
  btn.appendChild(btnLogo);
  btn.title = "Bowerbird：拖拽图片到此处采集，或点击后确认批量采集本页图片";
  btn.style.cssText = [
    "position:fixed",
    "bottom:24px",
    "right:24px",
    "width:48px",
    "height:48px",
    "border-radius:12px",
    "background:#0b1026",
    "overflow:hidden",
    "cursor:pointer",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "box-shadow:0 2px 12px rgba(0,0,0,0.35)",
    "opacity:0.85",
    "transition:opacity .15s",
  ].join(";");
  btn.addEventListener("mouseenter", () => (btn.style.opacity = "1"));
  btn.addEventListener("mouseleave", () => (btn.style.opacity = "0.85"));
  // 点击 → 弹出二次确认 → 批量采集本页图片
  btn.addEventListener("click", () => {
    const urls = collectImages();
    if (urls.length === 0) {
      showToast("未发现图片", false);
      return;
    }
    showConfirm(urls);
  });
  // 拖拽图片到按钮 → 采集（单张或多张）
  btn.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    btn.style.transform = "scale(1.15)";
    btn.style.boxShadow = "0 0 0 3px #5fd35f,0 2px 12px rgba(0,0,0,0.35)";
  });
  btn.addEventListener("dragleave", resetBtnStyle);
  btn.addEventListener("drop", (e) => {
    e.preventDefault();
    resetBtnStyle();
    const urls = urlsFromDropEvent(e);
    if (urls.length === 0) {
      showToast("未识别到图片地址", false);
      return;
    }
    saveAll(urls);
  });
  document.documentElement.appendChild(btn);

  function resetBtnStyle() {
    btn.style.transform = "";
    btn.style.boxShadow = "0 2px 12px rgba(0,0,0,0.35)";
  }

  function showToast(text, ok = true) {
    const t = document.createElement("div");
    t.textContent = text;
    t.style.cssText = [
      "position:fixed",
      "bottom:80px",
      "right:24px",
      "padding:8px 12px",
      "border-radius:6px",
      "font:13px -apple-system,sans-serif",
      "color:#fff",
      ok ? "background:#2e7d32" : "background:#c62828",
      "z-index:2147483647",
      "box-shadow:0 2px 8px rgba(0,0,0,0.3)",
    ].join(";");
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  function collectImages() {
    const set = new Set();
    document.querySelectorAll("img[src]").forEach((i) => {
      const src = i.currentSrc || i.src;
      if (src && /^https?:\/\//.test(src)) set.add(src);
    });
    return Array.from(set);
  }

  function saveAll(urls) {
    showToast("正在采集…");
    // 串行下载：整页几十张图同时打到本地服务会挤满连接，反而让每张都在 12 秒内超时。
    // 单张完成后再继续下一张，慢站点也能稳定看到逐张结果。
    saveSequentially(urls).then((res) => {
      const ok = res.filter((r) => r && r.ok).length;
      const firstError = res.find((r) => r && !r.ok)?.error;
      showToast(
        ok > 0
          ? firstError
            ? `部分素材采集失败：${firstError}`
            : "已保存到 Bowerbird"
          : `采集失败：${firstError || "未知错误"}`,
        ok > 0 && !firstError,
      );
    });
  }

  async function saveSequentially(urls) {
    const results = [];
    for (const url of urls) {
      results.push(await saveViaWs([url]).then((items) => items[0]));
    }
    return results;
  }

  // 从 drop 事件的 dataTransfer 提取 http(s) 图片地址（兼容多张 / <img> HTML 片段）
  function urlsFromDropEvent(e) {
    const dt = e.dataTransfer;
    const imageUrls = new Set();
    const push = (u) => {
      try {
        const absolute = new URL(u, location.href).href;
        if (/^https?:\/\//.test(absolute)) imageUrls.add(absolute);
      } catch { /* ignore invalid drag data */ }
    };
    // 浏览器拖拽图片时，uri-list/text/plain 往往是外层 <a> 的页面地址，
    // text/html 才含真实 <img src>。优先图片标签，避免把页面 HTML 当成第二张图片。
    const html = dt.getData("text/html") || "";
    const re = /<img[^>]+src=["']?([^"'\s>]+)/gi;
    let m;
    while ((m = re.exec(html))) push(m[1]);
    if (imageUrls.size > 0) return Array.from(imageUrls);

    // 没有 HTML 图片片段时（例如直接拖地址栏中的图片），才回退到 URI 文本。
    for (const type of ["text/uri-list", "text/plain"]) {
      (dt.getData(type) || "").trim().split(/\s+/).forEach(push);
    }
    return Array.from(imageUrls);
  }

  // 批量采集前的二次确认浮层
  function showConfirm(urls) {
    hideConfirm();
    const card = document.createElement("div");
    card.id = "__bowerbird_confirm";
    card.style.cssText = [
      "position:fixed",
      "bottom:84px",
      "right:24px",
      "padding:12px 14px",
      "border-radius:10px",
      "background:#1f2330",
      "color:#fff",
      "font:13px -apple-system,sans-serif",
      "box-shadow:0 4px 16px rgba(0,0,0,0.4)",
      "z-index:2147483647",
      "min-width:180px",
    ].join(";");
    const label = document.createElement("div");
    label.textContent = "采集本页图片？";
    label.style.marginBottom = "10px";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
    const baseBtnStyle =
      "border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font:13px -apple-system,sans-serif";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    cancel.style.cssText = baseBtnStyle + ";background:#3a3f4f;color:#fff";
    const ok = document.createElement("button");
    ok.textContent = "采集";
    ok.style.cssText = baseBtnStyle + ";background:#7c9cff;color:#000;font-weight:600";
    actions.append(cancel, ok);
    card.append(label, actions);
    document.documentElement.appendChild(card);

    const close = () => card.remove();
    const timer = setTimeout(close, 10000);
    cancel.onclick = () => {
      clearTimeout(timer);
      close();
    };
    ok.onclick = () => {
      clearTimeout(timer);
      close();
      saveAll(urls);
    };
    card.addEventListener("mousedown", (e) => e.stopPropagation());
  }

  function hideConfirm() {
    document.getElementById("__bowerbird_confirm")?.remove();
  }

  // Alt + 点击图片 → 单张保存
  document.addEventListener("click", (e) => {
    if (!e.altKey) return;
    const target = e.target;
    if (target && target.tagName === "IMG") {
      const src = target.currentSrc || target.src;
      if (src && /^https?:\/\//.test(src)) {
        e.preventDefault();
        e.stopPropagation();
        saveViaWs([src]).then((res) => {
          showToast(
            res[0]?.ok ? `已保存：${src.split("/").pop()}` : `保存失败：${res[0]?.error || "未知错误"}`,
            res[0]?.ok,
          );
        });
      }
    }
  }, true);

  // 图片读取必须由扩展后台完成：后台拥有站点权限和当前浏览器登录态，随后上传字节到桌面端。
  function saveViaWs(urls) {
    return Promise.all(
      urls.map(
        (url) =>
          new Promise((resolve) => {
            chrome.runtime.sendMessage(
              { type: "save_image", url, pageUrl: location.href },
              (response) => {
                if (chrome.runtime.lastError) {
                  resolve({ ok: false, error: chrome.runtime.lastError.message });
                  return;
                }
                resolve(response || { ok: false, error: "扩展后台没有返回结果" });
              },
            );
          })
      )
    );
  }
})();
