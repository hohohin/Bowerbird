// Bowerbird content script：悬浮按钮支持 ①拖拽图片投放采集 ②点击→二次确认批量采集本页 ③Alt+点击图片单张保存。
// 与 background.js 通过 chrome.runtime.sendMessage 通信。

(function () {
  if (window.__bowerbirdInjected) return;
  window.__bowerbirdInjected = true;

  const WS_URL = "ws://127.0.0.1:39871/ws";

  // ---- 悬浮按钮：拖拽图片到此处采集 / 点击 → 二次确认批量采集本页 ----
  const btn = document.createElement("div");
  btn.textContent = "🐦";
  btn.title = "Bowerbird：拖拽图片到此处采集，或点击后确认批量采集本页图片";
  btn.style.cssText = [
    "position:fixed",
    "bottom:24px",
    "right:24px",
    "width:48px",
    "height:48px",
    "border-radius:50%",
    "background:#7c9cff",
    "color:#000",
    "cursor:pointer",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "font-size:24px",
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
    btn.style.background = "#5fd35f";
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
    btn.style.background = "#7c9cff";
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
    showToast(`采集中…（${urls.length} 张）`);
    saveViaWs(urls).then((res) => {
      const ok = res.filter((r) => r && r.ok).length;
      showToast(`已保存 ${ok}/${urls.length} 张到 Bowerbird`, ok > 0);
    });
  }

  // 从 drop 事件的 dataTransfer 提取 http(s) 图片地址（兼容多张 / <img> HTML 片段）
  function urlsFromDropEvent(e) {
    const dt = e.dataTransfer;
    const found = new Set();
    const push = (u) => {
      if (u && /^https?:\/\//.test(u)) found.add(u);
    };
    for (const type of ["text/uri-list", "text/plain"]) {
      (dt.getData(type) || "").trim().split(/\s+/).forEach(push);
    }
    const html = dt.getData("text/html") || "";
    const re = /<img[^>]+src=["']?([^"'\s>]+)/gi;
    let m;
    while ((m = re.exec(html))) push(m[1]);
    return Array.from(found);
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
    label.textContent = `发现 ${urls.length} 张图片，全部采集？`;
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
          showToast(res[0]?.ok ? `已保存：${src.split("/").pop()}` : "保存失败", res[0]?.ok);
        });
      }
    }
  }, true);

  // ---- 直连桌面端 WS（content script 也具备 DOM 上下文，便于提示）----
  function saveViaWs(urls) {
    return Promise.all(
      urls.map(
        (url) =>
          new Promise((resolve) => {
            let settled = false;
            const done = (v) => {
              if (!settled) {
                settled = true;
                resolve(v);
              }
            };
            try {
              const ws = new WebSocket(WS_URL);
              const timer = setTimeout(() => {
                done({ ok: false, error: "timeout" });
                ws.close();
              }, 12000);
              ws.onopen = () => {
                ws.send(JSON.stringify({ type: "save", url, page_url: location.href }));
              };
              ws.onmessage = (ev) => {
                clearTimeout(timer);
                try {
                  done(JSON.parse(ev.data));
                } catch {
                  done({ ok: false, error: "bad reply" });
                }
                ws.close();
              };
              ws.onerror = () => {
                clearTimeout(timer);
                done({ ok: false, error: "ws error（桌面端未开启？）" });
              };
            } catch (err) {
              done({ ok: false, error: String(err) });
            }
          })
      )
    );
  }
})();
