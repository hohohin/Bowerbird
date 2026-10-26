// 页面与后台共用的采集边界；保持浏览器取字节 → save_blob 两帧协议。
(function (root) {
  "use strict";
  const MAX_ITEMS = 100;
  const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
  const MAX_INLINE_BYTES = 20 * 1024 * 1024;
  const FETCH_TIMEOUT_MS = 45000;
  const UPLOAD_TIMEOUT_MS = 60000;
  // 后台可能先取图 45 秒，再等待桌面入库 60 秒；页面必须等完整链路。
  const MESSAGE_TIMEOUT_MS = FETCH_TIMEOUT_MS + UPLOAD_TIMEOUT_MS + 5000;

  function limitBatch(batch) {
    const items = batch.items.slice(0, MAX_ITEMS);
    return {
      ...batch,
      items,
      label: batch.items.length > MAX_ITEMS
        ? `发现 ${batch.items.length} 张图片，本次最多采集前 ${MAX_ITEMS} 张，继续？`
        : batch.label,
    };
  }

  function uploadBytes(bytes, metadata) {
    return new Promise((resolve) => {
      let finished = false;
      let sent = false;
      let ws;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { ws?.close(); } catch { /* ignore */ }
        resolve(result);
      };
      const disconnected = () => finish({
        ok: false,
        code: sent ? "result_unknown" : "desktop_unavailable",
        error: sent ? "桌面入库回执尚未确认" : "无法连接 Bowerbird 桌面端",
      });
      const timer = setTimeout(disconnected, UPLOAD_TIMEOUT_MS);
      try {
        ws = new WebSocket("ws://127.0.0.1:39871/ws");
        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
          try {
            ws.send(JSON.stringify({ type: "save_blob", ...metadata }));
            ws.send(bytes);
            sent = true;
          } catch { disconnected(); }
        };
        ws.onmessage = (event) => {
          try {
            const result = JSON.parse(event.data);
            if (typeof result?.ok !== "boolean") throw new Error("invalid receipt");
            finish(result);
          } catch {
            finish({ ok: false, code: "result_unknown", error: "桌面入库回执无法解析" });
          }
        };
        ws.onerror = disconnected;
        ws.onclose = disconnected;
      } catch { disconnected(); }
    });
  }

  function requestBackground(item) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, code: "result_unknown" }), MESSAGE_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage({
          type: "save_image",
          url: item.media_url,
          pageUrl: item.source_url || "",
          candidateKind: item.candidate_kind || "image-url",
          candidateSource: item.candidate_source || "unknown",
        }, (response) => {
          const error = chrome.runtime.lastError?.message;
          if (error) finish({ ok: false, code: "result_unknown", error });
          else finish(response || { ok: false, code: "result_unknown" });
        });
      } catch (error) {
        finish({ ok: false, code: "reload_extension", error: String(error) });
      }
    });
  }

  async function runBatch(items, handlers, onProgress = () => {}) {
    const selected = items.slice(0, MAX_ITEMS);
    const summary = { total: selected.length, completed: 0, saved: 0, failed: 0, unconfirmed: 0, results: [] };
    onProgress({ ...summary });
    for (const item of selected) {
      let result;
      try {
        if (item.canvas) result = await handlers.canvas(item);
        else if (/^(blob:|data:image\/)/i.test(item.media_url || "")) result = await handlers.local(item);
        else result = await handlers.remote(item);
      } catch (error) {
        result = { ok: false, code: "collect_failed", error: String(error) };
      }
      result ||= { ok: false, code: "result_unknown" };
      summary.results.push(result);
      summary.completed += 1;
      if (result.ok) summary.saved += 1;
      else if (result.code === "result_unknown") summary.unconfirmed += 1;
      else summary.failed += 1;
      onProgress({ ...summary });
    }
    return summary;
  }

  function failureMessage(result) {
    if (result?.code === "result_unknown") return "部分图片的保存结果尚未确认，请先查看桌面素材库，不要重复采集。";
    if (result?.code === "reload_extension") return "扩展已更新或失效，请重新加载扩展并刷新网页后再试。";
    const error = String(result?.error || "");
    if (result?.code === "desktop_unavailable" || /无法连接.*桌面|ECONNREFUSED/.test(error)) {
      return "请先启动 Bowerbird 桌面应用，再重新采集未保存的图片。";
    }
    if (result?.code === "fetch_timeout" || /读取.*超时|AbortError/.test(error)) return "读取图片超时，请检查网络后再试。";
    if (result?.code === "too_large" || /超过.*上限/.test(error)) return "图片过大，请选择较小的图片后再试。";
    if (result?.code === "canvas_blocked") return "网页限制了画布导出，请尝试采集原始图片。";
    if (/HTTP (401|403)/.test(error)) return "网站拒绝读取图片，请确认已登录并能打开原图后再试。";
    if (/HTTP (404|410)/.test(error)) return "图片地址已失效，请刷新网页后再试。";
    if (result?.code === "invalid_image" || /不是可识别图片|图片字节为空/.test(error)) return "未读取到支持的图片，请打开原图后再试。";
    if (result?.code === "fetch_failed" || /浏览器读取失败|Failed to fetch/.test(error)) return "未能读取图片，请检查网页登录状态和网络后再试。";
    return "图片未能保存，请确认桌面应用正常运行，再重试未保存的图片。";
  }

  function progressMessage(summary, finished = false) {
    const counts = `已保存 ${summary.saved} 张` +
      (summary.failed ? `，失败 ${summary.failed} 张` : "") +
      (summary.unconfirmed ? `，待确认 ${summary.unconfirmed} 张` : "");
    if (!finished) return `采集中 ${summary.completed}/${summary.total} · ${counts}`;
    const issue = summary.results.find((result) => result.code === "result_unknown") || summary.results.find((result) => !result.ok);
    return `采集结束 · ${counts}（共 ${summary.total} 张）` + (issue ? `。${failureMessage(issue)}` : "");
  }

  root.BowerbirdCollection = {
    MAX_ITEMS, MAX_IMAGE_BYTES, MAX_INLINE_BYTES, FETCH_TIMEOUT_MS, UPLOAD_TIMEOUT_MS, MESSAGE_TIMEOUT_MS,
    limitBatch, uploadBytes, requestBackground, runBatch, failureMessage, progressMessage,
  };
})(globalThis);
