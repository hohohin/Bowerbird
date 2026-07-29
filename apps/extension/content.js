// Bowerbird content script：拖拽、批量采集、Alt+点击单张保存。
// 小红书使用页面结构化数据，其他站点回退到通用 DOM 图片扫描。

(function () {
  if (window.__bowerbirdInjected) return;
  window.__bowerbirdInjected = true;

  const WS_URL = "ws://127.0.0.1:39871/ws";
  const XHS_HOST = "www.xiaohongshu.com";

  // 心跳：让桌面端知道扩展已安装且当前浏览器可连接（每 15s 建短连发 ping）。
  // 不影响采集（采集走独立的 save_batch 连接）；桌面端据此显示「扩展已连接」。
  function heartbeat() {
    try {
      const ws = new WebSocket(WS_URL);
      const timer = setTimeout(() => ws.close(), 3000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "ping" }));
      ws.onmessage = () => { clearTimeout(timer); ws.close(); };
      ws.onerror = () => { clearTimeout(timer); };
    } catch { /* 桌面端未启动时静默，采集时再给明确提示 */ }
  }
  heartbeat();
  setInterval(heartbeat, 15000);

  const btn = document.createElement("div");
  const btnLogo = document.createElement("img");
  btnLogo.src = chrome.runtime.getURL("icons/48x48.png");
  btnLogo.alt = "";
  btnLogo.style.cssText = "width:100%;height:100%;display:block;pointer-events:none";
  btn.appendChild(btnLogo);
  btn.title = "Bowerbird：拖拽图片到此处采集，或点击后确认批量采集本页素材";
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
  btn.addEventListener("click", async () => {
    const batch = await collectMaterials();
    if (batch.items.length === 0) {
      showToast("未发现可采集素材", false);
      return;
    }
    showConfirm(batch);
  });
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
    saveBatch(makeGenericBatch(urls));
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
    setTimeout(() => t.remove(), 3000);
  }

  async function collectMaterials() {
    if (location.hostname === XHS_HOST) {
      const xhsBatch = await collectXiaohongshu();
      if (xhsBatch && xhsBatch.items.length > 0) return xhsBatch;
      const domBatch = collectXhsDomMaterials();
      if (domBatch.items.length > 0) return domBatch;
    }
    return makeGenericBatch(collectDomImages());
  }

  async function collectXiaohongshu() {
    const detailId = location.pathname.match(/^\/explore\/([^/]+)/)?.[1];
    let state = readXhsInitialState();
    // 站内 SPA 打开详情时，首屏 script 仍可能是发现页状态；按当前可见 URL 重取公开 HTML。
    if (detailId && !state?.note?.noteDetailMap?.[detailId]) {
      state = (await fetchXhsDetailState()) || state;
    }
    if (!state) return null;

    if (detailId) {
      const detail = state.note?.noteDetailMap?.[detailId];
      const note = detail?.note;
      if (!note || note.type === "video") return null;
      const images = dedupeBy(
        (note.imageList || [])
          .map((image, index, all) => ({
            media_url: normalizeMediaUrl(
              image.urlDefault ||
                image.urlPre ||
                image.infoList?.find((item) => item.imageScene === "WB_DFT")?.url
            ),
            source_url: canonicalXhsNoteUrl(detailId),
            source_id: detailId,
            title: note.title || "小红书图片",
            author: note.user?.nickname || "",
            index,
            total: all.length,
            media_kind: "image",
          }))
          .filter((item) => item.media_url),
        (item) => item.media_url
      );
      return {
        source_site: "xiaohongshu",
        label: `本笔记共 ${images.length} 张图片，全部采集？`,
        items: images,
      };
    }

    const feeds = state.feed?.feeds;
    if (!Array.isArray(feeds)) return null;
    const structuredCovers =
      feeds
        .filter((feed) => feed?.modelType === "note" && !feed.ignore)
        .map((feed) => {
          const card = feed.noteCard || {};
          return {
            media_url: normalizeMediaUrl(card.cover?.urlDefault || card.cover?.urlPre),
            source_url: canonicalXhsNoteUrl(feed.id),
            source_id: feed.id || "",
            title: card.displayTitle || "小红书封面",
            author: card.user?.nickname || "",
            media_kind: "cover",
            note_type: card.type || "normal",
          };
        })
        .filter((item) => item.media_url && item.source_id);
    const covers = dedupeBy(
      structuredCovers.concat(collectXhsDomCovers()),
      (item) => item.source_id
    );
    covers.forEach((item, index) => {
      item.index = index;
      item.total = covers.length;
    });
    return {
      source_site: "xiaohongshu",
      label: `发现 ${covers.length} 条笔记封面，全部采集？`,
      items: covers,
    };
  }

  function collectXhsDomMaterials() {
    const detailId = location.pathname.match(/^\/explore\/([^/]+)/)?.[1];
    if (detailId) {
      const images = dedupeBy(
        Array.from(document.querySelectorAll(".note-slider-img img"))
          .map((image) => normalizeMediaUrl(image.currentSrc || image.src))
          .filter(Boolean),
        (url) => url
      );
      return {
        source_site: "xiaohongshu",
        label: `当前页面发现 ${images.length} 张图片，全部采集？`,
        items: images.map((url, index) => ({
          media_url: url,
          source_url: canonicalXhsNoteUrl(detailId),
          source_id: detailId,
          index,
          total: images.length,
          media_kind: "image",
        })),
      };
    }
    const covers = collectXhsDomCovers();
    covers.forEach((item, index) => {
      item.index = index;
      item.total = covers.length;
    });
    return {
      source_site: "xiaohongshu",
      label: `发现 ${covers.length} 条笔记封面，全部采集？`,
      items: covers,
    };
  }

  function collectXhsDomCovers() {
    return dedupeBy(
      Array.from(document.querySelectorAll('a[href*="/explore/"] img'))
        .map((image) => {
          const link = image.closest('a[href*="/explore/"]');
          const noteId = link?.pathname.match(/^\/explore\/([^/]+)/)?.[1];
          return {
            media_url: normalizeMediaUrl(image.currentSrc || image.src),
            source_url: canonicalXhsNoteUrl(noteId),
            source_id: noteId || "",
            title: "小红书封面",
            media_kind: "cover",
          };
        })
        .filter((item) => item.media_url && item.source_id),
      (item) => item.source_id
    );
  }

  function readXhsInitialState(root = document) {
    const prefix = "window.__INITIAL_STATE__=";
    const script = Array.from(root.scripts || []).find((node) =>
      (node.textContent || "").startsWith(prefix)
    );
    if (!script) return null;
    try {
      const json = replaceUndefinedValues(script.textContent.slice(prefix.length));
      return JSON.parse(json);
    } catch (err) {
      console.warn("Bowerbird: 小红书页面数据解析失败，回退 DOM 扫描", err);
      return null;
    }
  }

  async function fetchXhsDetailState() {
    try {
      const response = await fetch(location.href, {
        credentials: "omit",
        headers: { Accept: "text/html" },
      });
      if (!response.ok) return null;
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      return readXhsInitialState(doc);
    } catch (err) {
      console.warn("Bowerbird: 小红书详情 HTML 读取失败，回退当前 DOM", err);
      return null;
    }
  }

  // 小红书的内嵌对象接近 JSON，但部分值是 undefined；只在字符串外替换，绝不执行页面文本。
  function replaceUndefinedValues(text) {
    let output = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        output += ch;
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        output += ch;
      } else if (text.startsWith("undefined", i)) {
        output += "null";
        i += "undefined".length - 1;
      } else {
        output += ch;
      }
    }
    return output;
  }

  function canonicalXhsNoteUrl(noteId) {
    return noteId ? `https://${XHS_HOST}/explore/${noteId}` : location.href;
  }

  function normalizeMediaUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value, location.href);
      if (url.protocol === "http:" && /(^|\.)xhscdn\.com$/.test(url.hostname)) {
        url.protocol = "https:";
      }
      return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  function dedupeBy(items, keyOf) {
    const seen = new Set();
    return items.filter((item) => {
      const key = keyOf(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function collectDomImages() {
    const set = new Set();
    document.querySelectorAll("img[src]").forEach((image) => {
      const src = normalizeMediaUrl(image.currentSrc || image.src);
      if (src) set.add(src);
    });
    return Array.from(set);
  }

  function makeGenericBatch(urls, sourceUrl = location.href) {
    const unique = dedupeBy(urls.map(normalizeMediaUrl).filter(Boolean), (url) => url);
    return {
      source_site: "web",
      label: `发现 ${unique.length} 张图片，全部采集？`,
      items: unique.map((url, index) => ({
        media_url: url,
        source_url: sourceUrl,
        index,
        total: unique.length,
        media_kind: "image",
      })),
    };
  }

  function urlsFromDropEvent(e) {
    const dt = e.dataTransfer;
    const found = new Set();
    const push = (url) => {
      const normalized = normalizeMediaUrl(url);
      if (normalized) found.add(normalized);
    };
    for (const type of ["text/uri-list", "text/plain"]) {
      (dt.getData(type) || "")
        .trim()
        .split(/\s+/)
        .forEach(push);
    }
    const html = dt.getData("text/html") || "";
    const re = /<img[^>]+src=["']?([^"'\s>]+)/gi;
    let match;
    while ((match = re.exec(html))) push(match[1]);
    return Array.from(found);
  }

  function showConfirm(batch) {
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
      "min-width:220px",
      "max-width:320px",
    ].join(";");
    const label = document.createElement("div");
    label.textContent = batch.label;
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
    const timer = setTimeout(close, 15000);
    cancel.onclick = () => {
      clearTimeout(timer);
      close();
    };
    ok.onclick = () => {
      clearTimeout(timer);
      close();
      saveBatch(batch);
    };
    card.addEventListener("mousedown", (e) => e.stopPropagation());
  }

  function hideConfirm() {
    document.getElementById("__bowerbird_confirm")?.remove();
  }

  document.addEventListener(
    "click",
    (e) => {
      if (!e.altKey) return;
      const target = e.target;
      if (!target || target.tagName !== "IMG") return;
      const src = normalizeMediaUrl(target.currentSrc || target.src);
      if (!src) return;
      e.preventDefault();
      e.stopPropagation();
      const noteLink = target.closest('a[href*="/explore/"]')?.href;
      saveBatch(makeGenericBatch([src], noteLink || location.href));
    },
    true
  );

  function saveBatch(batch) {
    if (batch.items.length === 0) return;
    showToast(`采集中…（${batch.items.length} 项）`);
    saveViaWs(batch).then((response) => {
      const results = Array.isArray(response?.results) ? response.results : [response];
      const ok = results.filter((item) => item?.ok).length;
      showToast(`已保存 ${ok}/${batch.items.length} 项到 Bowerbird`, ok > 0);
    });
  }

  // 一个批次只建立一个 WS；桌面端顺序下载并一次性返回逐项结果。
  function saveViaWs(batch) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      try {
        const ws = new WebSocket(WS_URL);
        const timeoutMs = Math.min(180000, Math.max(15000, batch.items.length * 5000));
        const timer = setTimeout(() => {
          done({ ok: false, error: "timeout", results: [] });
          ws.close();
        }, timeoutMs);
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: "save_batch",
              source_site: batch.source_site,
              items: batch.items,
            })
          );
        };
        ws.onmessage = (event) => {
          clearTimeout(timer);
          try {
            done(JSON.parse(event.data));
          } catch {
            done({ ok: false, error: "bad reply", results: [] });
          }
          ws.close();
        };
        ws.onerror = () => {
          clearTimeout(timer);
          done({ ok: false, error: "ws error（桌面端未开启？）", results: [] });
        };
      } catch (err) {
        done({ ok: false, error: String(err), results: [] });
      }
    });
  }
})();
