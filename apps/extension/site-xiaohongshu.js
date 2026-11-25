(() => {
  "use strict";
  const XHS_HOST = "www.xiaohongshu.com";
  const { FETCH_TIMEOUT_MS } = globalThis.BowerbirdCollection;
  const { xhs } = globalThis.BowerbirdVideo;

  async function collectImages() {
    if (location.hostname !== XHS_HOST) return null;
    const structured = await collectXiaohongshu();
    return structured?.items.length ? structured : collectXhsDomMaterials();
  }

  async function collectVideo() {
    if (location.hostname !== XHS_HOST) return null;
    const detailId = location.pathname.match(/^\/explore\/([^/]+)/)?.[1];
    let state = readXhsInitialState();
    if (detailId && !state?.note?.noteDetailMap?.[detailId]) state = (await fetchXhsDetailState()) || state;
    const detail = state?.note?.noteDetailMap?.[detailId];
    return xhs(detail?.note || detail, canonicalXhsNoteUrl(detailId));
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(location.href, {
        credentials: "omit",
        headers: { Accept: "text/html" },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      return readXhsInitialState(doc);
    } catch (err) {
      console.warn("Bowerbird: 小红书详情 HTML 读取失败，回退当前 DOM", err);
      return null;
    } finally {
      clearTimeout(timer);
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

  globalThis.BowerbirdXiaohongshu = { collectImages, collectVideo };
})();
