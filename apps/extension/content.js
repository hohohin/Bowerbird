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
  btn.addEventListener("drop", async (e) => {
    e.preventDefault();
    resetBtnStyle();
    const candidates = candidatesFromDropEvent(e);
    if (candidates.length === 0) {
      showToast("未识别到图片地址", false);
      return;
    }
    const local = candidates.find((item) => item.kind === "blob" || item.kind === "data");
    if (local) {
      showToast("采集中…");
      const result = await saveLocalCandidate(local, location.href);
      showCollectResult(result.ok);
      return;
    }
    saveBatch(makeGenericBatch(candidates));
  });
  document.documentElement.appendChild(btn);

  function resetBtnStyle() {
    btn.style.transform = "";
    btn.style.boxShadow = "0 2px 12px rgba(0,0,0,0.35)";
  }

  function showToast(text, ok = true) {
    document.getElementById("__bowerbird_toast")?.remove();
    const t = document.createElement("div");
    t.id = "__bowerbird_toast";
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

  function showCollectResult(ok) {
    showToast(ok ? "采集成功" : "采集失败", ok);
  }

  async function collectMaterials() {
    if (location.hostname === XHS_HOST) {
      const xhsBatch = await collectXiaohongshu();
      if (xhsBatch && xhsBatch.items.length > 0) return xhsBatch;
      const domBatch = collectXhsDomMaterials();
      if (domBatch.items.length > 0) return domBatch;
    }
    return makeGenericBatch(collectGenericCandidates());
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

  const C = globalThis.BowerbirdCandidates;
  const LAZY_URL_ATTRS = [
    "data-src", "data-original", "data-lazy-src", "data-url", "data-image", "data-original-src",
  ];
  const LAZY_SRCSET_ATTRS = ["data-srcset", "data-lazy-srcset"];

  function elementVisible(el) {
    const rect = el.getBoundingClientRect?.();
    if (!rect) return true;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
  }

  function addElementImageCandidates(out, image, pageUrl, priority = 80) {
    const visible = elementVisible(image);
    const options = {
      pageUrl,
      width: image.naturalWidth || image.clientWidth || 0,
      height: image.naturalHeight || image.clientHeight || 0,
      visible,
    };
    // 同一 <img> 元素在 currentSrc / srcset / picture / lazy data-* 里通常指向**同一张图
    // 的不同分辨率版本**（如 Pinterest 236w 网格缩略图与完整图）。若全部发出，扩展会把它
    // 当作多张采集 → 瀑布流出现两张一样素材（即使后端已做 dHash 阈值去重，也尽量在源头
    // 收敛）。故每个元素只取一张候选：按来源可信度取最高清版本（见 pickBestVariant）。
    const candidates = [];
    const current = C.candidate(image.currentSrc || image.getAttribute("src"), document.baseURI, {
      ...options, source: "currentSrc", priority: priority + 20,
    });
    if (current) candidates.push(current);

    const ownSrcset = C.parseSrcset(image.getAttribute("srcset"), document.baseURI);
    if (ownSrcset) candidates.push(C.candidate(ownSrcset.url, document.baseURI, {
      ...options, source: "srcset", priority: priority + 15,
    }));
    image.closest("picture")?.querySelectorAll("source[srcset]").forEach((source) => {
      const selected = C.parseSrcset(source.getAttribute("srcset"), document.baseURI);
      if (selected) candidates.push(C.candidate(selected.url, document.baseURI, {
        ...options, source: "picture", priority: priority + 15,
      }));
    });
    for (const attr of LAZY_URL_ATTRS) {
      const value = image.getAttribute(attr);
      if (value) candidates.push(C.candidate(value, document.baseURI, {
        ...options, source: "lazy", priority: priority + 10,
      }));
    }
    for (const attr of LAZY_SRCSET_ATTRS) {
      const selected = C.parseSrcset(image.getAttribute(attr), document.baseURI);
      if (selected) candidates.push(C.candidate(selected.url, document.baseURI, {
        ...options, source: "lazy-srcset", priority: priority + 10,
      }));
    }
    const best = pickBestVariant(candidates);
    if (best) out.push(best);
  }

  // 从同一元素的多分辨率候选中挑「最高分辨率」的一张。
  // 同一 <img> 的 currentSrc / srcset / lazy data-* 通常指向同一张图的不同分辨率版本；
  // 且 `naturalWidth/clientWidth` 是该元素**当前显示**的尺寸、对所有候选相同，无法据此区分
  // 各 URL 的真实分辨率。故按来源可信度分级：
  //   0 srcset/picture/lazy-srcset —— 显式的分辨率集合，选中的最高描述符就是最高清版本
  //   1 lazy data-*（data-src 等）—— 懒加载的真实大图（占位符只是 currentSrc）
  //   2 currentSrc —— 当前显示的（可能是缩略图/占位符）
  // 同层内优先宽高更大的（srcset 已按最高描述符选中，通常同 URL）。
  function pickBestVariant(candidates) {
    const tier = (source) =>
      source === "srcset" || source === "picture" || source === "lazy-srcset"
        ? 0
        : source === "lazy"
          ? 1
          : 2;
    return candidates
      .filter(Boolean)
      .map((item) => ({ item, key: tier(item.source), area: (item.width || 0) * (item.height || 0) }))
      .sort((a, b) => a.key - b.key || b.area - a.area)[0]?.item || null;
  }

  function cssBackgroundCandidates(el, pageUrl, priority = 55) {
    if (!elementVisible(el)) return [];
    const rect = el.getBoundingClientRect?.();
    if (rect && rect.width * rect.height < 4096) return [];
    const background = getComputedStyle(el).backgroundImage || "";
    const found = [];
    const re = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    let match;
    while ((match = re.exec(background))) {
      found.push(C.candidate(match[1], document.baseURI, {
        source: "css", priority, pageUrl,
        width: rect?.width || 0, height: rect?.height || 0, visible: true,
      }));
    }
    return found.filter(Boolean);
  }

  function collectRoots() {
    const roots = [document];
    let seenNodes = 0;
    for (let i = 0; i < roots.length && seenNodes < 5000; i += 1) {
      const nodes = roots[i].querySelectorAll?.("*") || [];
      for (const node of nodes) {
        seenNodes += 1;
        if (node.shadowRoot) roots.push(node.shadowRoot);
        if (seenNodes >= 5000) break;
      }
    }
    return roots;
  }

  function collectMetadataCandidates(out, pageUrl) {
    const selectors = [
      'meta[property="og:image:secure_url"]', 'meta[property="og:image"]',
      'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]', 'link[rel="image_src"]',
    ];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((el) => {
        const value = el.getAttribute("content") || el.getAttribute("href");
        out.push(C.candidate(value, document.baseURI, { source: "metadata", priority: 70, pageUrl }));
      });
    }

    let totalJson = 0;
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      const text = script.textContent || "";
      totalJson += text.length;
      if (totalJson > 1024 * 1024 || text.length > 512 * 1024) return;
      try {
        const visit = (value, depth = 0) => {
          if (depth > 8 || value == null) return;
          if (typeof value === "string") return;
          if (Array.isArray(value)) return value.forEach((v) => visit(v, depth + 1));
          if (typeof value !== "object") return;
          for (const key of ["image", "contentUrl", "thumbnailUrl"]) {
            const image = value[key];
            const add = (v) => {
              const url = typeof v === "string" ? v : v?.url || v?.contentUrl;
              out.push(C.candidate(url, document.baseURI, { source: "jsonld", priority: 65, pageUrl }));
            };
            if (Array.isArray(image)) image.forEach(add);
            else if (image) add(image);
          }
          for (const [key, child] of Object.entries(value)) {
            if (["image", "contentUrl", "thumbnailUrl"].includes(key)) continue;
            if (key === "@graph" || key === "itemListElement" || key === "mainEntity") visit(child, depth + 1);
          }
        };
        visit(JSON.parse(text));
      } catch { /* malformed JSON-LD is common; skip */ }
    });
  }

  function collectGenericCandidates() {
    const pageUrl = location.href;
    const out = [];
    const roots = collectRoots();
    for (const root of roots) {
      root.querySelectorAll?.("img").forEach((img) => addElementImageCandidates(out, img, pageUrl));
      root.querySelectorAll?.("video[poster]").forEach((video) => {
        out.push(C.candidate(video.poster || video.getAttribute("poster"), document.baseURI, {
          source: "poster", priority: 60, pageUrl,
          width: video.videoWidth || video.clientWidth, height: video.videoHeight || video.clientHeight,
          visible: elementVisible(video),
        }));
      });
      root.querySelectorAll?.('svg image[href], svg image[xlink\\:href]').forEach((image) => {
        out.push(C.candidate(image.getAttribute("href") || image.getAttribute("xlink:href"), document.baseURI, {
          source: "svg-image", priority: 60, pageUrl, visible: elementVisible(image),
        }));
      });
      const cssSelector = '[style*="background"], [role="img"], [class*="image" i], [class*="photo" i], [class*="hero" i], [class*="cover" i], [class*="gallery" i], [class*="product" i]';
      Array.from(root.querySelectorAll?.(cssSelector) || []).slice(0, 1000).forEach((el) => {
        out.push(...cssBackgroundCandidates(el, pageUrl));
      });
    }
    document.querySelectorAll('link[rel="preload"][as="image"]').forEach((link) => {
      out.push(C.candidate(link.href, document.baseURI, { source: "preload", priority: 55, pageUrl }));
    });
    collectMetadataCandidates(out, pageUrl);
    return C.rankAndDedupe(out);
  }

  function makeGenericBatch(values, sourceUrl = location.href) {
    const candidates = values.map((value) => {
      if (typeof value === "string") {
        return C.candidate(value, document.baseURI, {
          source: "legacy", priority: 50, pageUrl: sourceUrl,
        });
      }
      return value;
    });
    const unique = C.rankAndDedupe(candidates);
    return {
      source_site: "web",
      label: `发现 ${unique.length} 张图片，全部采集？`,
      items: unique.map((item, index) => ({
        media_url: item.url,
        source_url: item.pageUrl || sourceUrl,
        candidate_kind: item.kind,
        candidate_source: item.source,
        index,
        total: unique.length,
        media_kind: "image",
      })),
    };
  }

  function candidatesFromDropEvent(e) {
    const dt = e.dataTransfer;
    return C.dropCandidatesFromValues({
      html: dt.getData("text/html") || "",
      uriList: dt.getData("text/uri-list") || "",
      plain: dt.getData("text/plain") || "",
      base: location.href,
    });
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

  async function uploadLocalBytes(bytes, metadata) {
    if (!bytes || bytes.byteLength === 0) return { ok: false, error: "页面图片字节为空" };
    if (bytes.byteLength > 20 * 1024 * 1024) {
      return { ok: false, error: "页面内嵌图片超过 20 MiB 上限" };
    }
    return new Promise((resolve) => {
      let finished = false;
      let ws;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { ws?.close(); } catch { /* ignore */ }
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false, error: "桌面端接收图片超时" }), 55000);
      try {
        ws = new WebSocket(WS_URL);
        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "save_blob", ...metadata }));
          ws.send(bytes);
        };
        ws.onmessage = (event) => {
          try { finish(JSON.parse(event.data)); }
          catch { finish({ ok: false, error: "桌面端响应无法解析" }); }
        };
        ws.onerror = () => finish({ ok: false, error: "无法连接 Bowerbird 桌面端" });
      } catch (error) {
        finish({ ok: false, error: String(error) });
      }
    });
  }

  async function saveLocalCandidate(candidate, pageUrl) {
    try {
      const response = await fetch(candidate.url);
      if (!response.ok) return { ok: false, error: `页面读取图片失败：HTTP ${response.status}` };
      const contentType = response.headers.get("content-type") || "";
      const bytes = await response.arrayBuffer();
      return uploadLocalBytes(bytes, {
        requested_url: pageUrl,
        effective_url: pageUrl,
        page_url: pageUrl,
        url: pageUrl,
        file_name: "page-image",
        content_type: contentType,
        candidate_source: candidate.source,
      });
    } catch (error) {
      return { ok: false, error: `页面读取内嵌图片失败：${String(error)}` };
    }
  }

  async function saveCanvas(canvas, pageUrl) {
    try {
      const blob = await new Promise((resolve, reject) => {
        try {
          canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("canvas 导出为空"))), "image/png");
        } catch (error) { reject(error); }
      });
      return uploadLocalBytes(await blob.arrayBuffer(), {
        requested_url: pageUrl,
        effective_url: pageUrl,
        page_url: pageUrl,
        url: pageUrl,
        file_name: "canvas.png",
        content_type: "image/png",
        candidate_source: "canvas",
      });
    } catch (error) {
      return { ok: false, error: `Canvas 无法导出（可能受跨域保护）：${String(error)}` };
    }
  }

  document.addEventListener(
    "click",
    async (e) => {
      if (!e.altKey) return;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
      const canvas = path.find((node) => node?.tagName === "CANVAS");
      if (canvas) {
        e.preventDefault();
        e.stopPropagation();
        showToast("采集中…");
        const result = await saveCanvas(canvas, location.href);
        showCollectResult(result.ok);
        return;
      }
      const image = path.find((node) => node?.tagName === "IMG");
      let candidates = [];
      let sourceElement = image;
      if (image) {
        const out = [];
        addElementImageCandidates(out, image, location.href, 1000);
        candidates = C.rankAndDedupe(out);
      } else {
        sourceElement = path.find(
          (node) => node instanceof Element && cssBackgroundCandidates(node, location.href, 1000).length > 0
        );
        if (sourceElement) candidates = cssBackgroundCandidates(sourceElement, location.href, 1000);
      }
      if (candidates.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const noteLink = sourceElement?.closest?.('a[href*="/explore/"]')?.href;
      candidates = candidates.map((item) => ({ ...item, explicit: true, pageUrl: noteLink || location.href }));
      const local = candidates.find((item) => item.kind === "blob" || item.kind === "data");
      if (local) {
        showToast("采集中…");
        const result = await saveLocalCandidate(local, noteLink || location.href);
        showCollectResult(result.ok);
        return;
      }
      saveBatch(makeGenericBatch(candidates, noteLink || location.href));
    },
    true
  );

  function saveBatch(batch) {
    if (batch.items.length === 0) return;
    showToast("采集中…");
    saveViaWs(batch).then((response) => {
      const results = Array.isArray(response?.results) ? response.results : [response];
      showCollectResult(results.length > 0 && results.every((item) => item?.ok));
    });
  }

  // 浏览器内取图：逐项交给 background service worker fetch（自动走浏览器系统代理 + Cookie），
  // background 再经 save_blob（metadata text + binary bytes）上传桌面端。避免桌面 reqwest 二次下载
  // 丢代理/登录态；Pinterest 等国外/Cookie 保护站走这条成熟路径。
  async function saveViaWs(batch) {
    const results = [];
    for (const item of batch.items) {
      const result = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(
          () => finish({ ok: false, error: "扩展后台读取图片超时" }),
          55000
        );
        try {
          chrome.runtime.sendMessage(
            {
              type: "save_image",
              url: item.media_url,
              pageUrl: item.source_url || location.href,
              candidateKind: item.candidate_kind || "image-url",
              candidateSource: item.candidate_source || "unknown",
            },
            (response) => {
              if (chrome.runtime.lastError) {
                finish({ ok: false, error: chrome.runtime.lastError.message });
              } else {
                finish(response || { ok: false, error: "扩展后台未响应" });
              }
            }
          );
        } catch (error) {
          finish({ ok: false, error: String(error) });
        }
      });
      results.push(result);
    }
    return {
      ok: results.every((item) => item?.ok),
      saved: results.filter((item) => item?.ok).length,
      total: results.length,
      results,
    };
  }
})();
