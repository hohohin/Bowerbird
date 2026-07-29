// Bowerbird 通用图片候选纯函数：浏览器 content script 与 Node 测试共用。
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BowerbirdCandidates = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_CANDIDATES = 100;

  function decodeHtml(value) {
    return String(value || "")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
  }

  function normalizeCandidateUrl(value, base) {
    const raw = decodeHtml(value).trim().replace(/^['"]|['"]$/g, "");
    if (!raw) return null;
    try {
      if (/^(blob:|data:image\/)/i.test(raw)) {
        return { url: raw, kind: raw.startsWith("blob:") ? "blob" : "data" };
      }
      const url = new URL(raw, base);
      if (!/^https?:$/.test(url.protocol)) return null;
      url.hash = "";
      return { url: url.href, kind: "image-url" };
    } catch {
      return null;
    }
  }

  function parseSrcset(value, base) {
    const entries = String(value || "")
      .split(",")
      .map((part) => {
        const bits = part.trim().split(/\s+/);
        const normalized = normalizeCandidateUrl(bits[0], base);
        if (!normalized) return null;
        const descriptor = bits[1] || "1x";
        const type = descriptor.endsWith("w") ? "w" : "x";
        const score = Number.parseFloat(descriptor) || (type === "x" ? 1 : 0);
        return { ...normalized, type, score };
      })
      .filter(Boolean);
    // 标准 srcset 不混用 w/x；遇到异常混用时优先宽度候选（最能代表原图尺寸）。
    const comparable = entries.some((item) => item.type === "w")
      ? entries.filter((item) => item.type === "w")
      : entries;
    comparable.sort((a, b) => b.score - a.score);
    return comparable[0] || null;
  }

  function candidate(value, base, options) {
    const normalized = normalizeCandidateUrl(value, base);
    if (!normalized) return null;
    return {
      ...normalized,
      source: options?.source || "unknown",
      priority: options?.priority || 0,
      pageUrl: options?.pageUrl || base || "",
      width: Number(options?.width) || 0,
      height: Number(options?.height) || 0,
      visible: options?.visible !== false,
      explicit: Boolean(options?.explicit),
      ...(options?.extra || {}),
    };
  }

  function rankAndDedupe(items, max = MAX_CANDIDATES) {
    const byUrl = new Map();
    for (const item of items.filter(Boolean)) {
      if (!item.explicit && item.width > 0 && item.height > 0 && item.width <= 2 && item.height <= 2) {
        continue;
      }
      const area = item.width * item.height;
      const score = item.priority + Math.min(area / 10000, 100) + (item.visible ? 5 : 0);
      const previous = byUrl.get(item.url);
      if (!previous || score > previous._score) byUrl.set(item.url, { ...item, _score: score });
    }
    return Array.from(byUrl.values())
      .sort((a, b) => b._score - a._score)
      .slice(0, max)
      .map(({ _score, ...item }) => item);
  }

  function attr(tag, name) {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
  }

  function extractImageCandidatesFromHtml(html, base, options = {}) {
    const found = [];
    const tags = String(html || "").match(/<(?:img|source)\b[^>]*>/gi) || [];
    for (const tag of tags) {
      const srcset = attr(tag, "srcset") || attr(tag, "data-srcset") || attr(tag, "data-lazy-srcset");
      const selected = parseSrcset(srcset, base);
      if (selected) {
        found.push(candidate(selected.url, base, {
          source: "drop-srcset", priority: 1000, pageUrl: options.pageUrl || base, explicit: true,
        }));
      }
      for (const name of ["src", "data-src", "data-original", "data-lazy-src", "data-original-src"]) {
        const value = attr(tag, name);
        if (value) found.push(candidate(value, base, {
          source: "drop-html", priority: 1000, pageUrl: options.pageUrl || base, explicit: true,
        }));
      }
    }
    return rankAndDedupe(found, MAX_CANDIDATES);
  }

  function dropCandidatesFromValues({ html, uriList, plain, base }) {
    // 关键语义：HTML 内一旦找到图片，只用图片；不混入链接包图片的外层商品页 URL。
    const htmlCandidates = extractImageCandidatesFromHtml(html, base, { pageUrl: base });
    if (htmlCandidates.length > 0) return htmlCandidates;

    const values = [];
    for (const text of [uriList, plain]) {
      String(text || "")
        .split(/\r?\n|\s+/)
        .filter((v) => v && !v.startsWith("#"))
        .forEach((v) => values.push(v));
    }
    return rankAndDedupe(
      values.map((value) => {
        const c = candidate(value, base, {
          source: "drop-text", priority: 900, pageUrl: base, explicit: true,
        });
        return c ? { ...c, kind: "page-or-image" } : null;
      }),
      MAX_CANDIDATES
    );
  }

  return {
    MAX_CANDIDATES,
    normalizeCandidateUrl,
    parseSrcset,
    candidate,
    rankAndDupe: rankAndDedupe,
    rankAndDedupe,
    extractImageCandidatesFromHtml,
    dropCandidatesFromValues,
  };
});
