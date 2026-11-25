(() => {
  "use strict";
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
        if (node.id !== "__bowerbird_overlay" && node.shadowRoot) roots.push(node.shadowRoot);
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
            if(key==="contentUrl" && [value["@type"]].flat().includes("VideoObject"))continue;
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
        width: item.width,
        height: item.height,
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

  // Instagram 等站点会在图片上覆盖透明层，并把 IMG 设为 pointer-events:none；
  // 点击路径里没有 IMG，但图片仍按几何位置可见。按点击坐标找回最贴合的那张。
  function imageAtPoint(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    let best = null;
    let bestArea = Infinity;
    let bestPixels = -1;
    let bestIndex = -1;
    let index = 0;
    for (const image of collectRoots().flatMap(root => Array.from(root.querySelectorAll("img")))) {
      const currentIndex = index++;
      const rect = image.getBoundingClientRect?.();
      if (!rect || rect.width <= 1 || rect.height <= 1) continue;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      if (!elementVisible(image)) continue;
      if (!(image.currentSrc || image.getAttribute?.("src"))) continue;
      const area = rect.width * rect.height;
      const pixels = (image.naturalWidth || 0) * (image.naturalHeight || 0);
      if (
        area < bestArea ||
        (area === bestArea && (pixels > bestPixels || (pixels === bestPixels && currentIndex > bestIndex)))
      ) {
        best = image;
        bestArea = area;
        bestPixels = pixels;
        bestIndex = currentIndex;
      }
    }
    return best;
  }

  globalThis.BowerbirdScanner = { collectRoots, collectGenericCandidates, makeGenericBatch, candidatesFromDropEvent, imageAtPoint, addElementImageCandidates, cssBackgroundCandidates };
})();
