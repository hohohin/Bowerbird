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
  const VIDEO_FETCH_TIMEOUT_MS = 120000;
  const VIDEO_UPLOAD_TIMEOUT_MS = 180000;
  const videoLimit = capabilities => Number.isSafeInteger(capabilities?.video_max_bytes) && capabilities.video_max_bytes > 0
    ? Math.min(209715200,capabilities.video_max_bytes) : 209715200;

  async function socketAccess() {
    try {
      if (typeof BowerbirdPairing !== "undefined") {
        return await BowerbirdPairing.proof("chrome-extension://" + chrome.runtime.id, "extension");
      }
      return await new Promise(resolve => chrome.runtime.sendMessage({type:"collect_access"}, result => {
        const error = chrome.runtime.lastError;
        resolve(error || !result ? {ok:false,code:"pair_required"} : result);
      }));
    } catch { return {ok:false,code:"pair_required"}; }
  }

  async function checkVideoSupport() {
    const access = await socketAccess();
    if (!access.ok) return access;
    return new Promise(resolve => {
      let ws, finished=false;
      const done=result=>{if(finished)return;finished=true;clearTimeout(timer);try{ws?.close();}catch{}resolve(result);};
      const timer=setTimeout(()=>done({ok:false,code:"desktop_unavailable"}),3000);
      try {
        ws=new WebSocket("ws://127.0.0.1:39871/ws", access.protocols);
        ws.onopen=()=>ws.send(JSON.stringify({type:"ping"}));
        ws.onmessage=event=>{try{const reply=JSON.parse(event.data);done(reply.capabilities?.video_blob===true ? {ok:true,maxBytes:videoLimit(reply.capabilities)} : {ok:false,code:"desktop_upgrade"});}catch{done({ok:false,code:"desktop_upgrade"});}};
        ws.onerror=()=>done({ok:false,code:"desktop_unavailable"});ws.onclose=ws.onerror;
      } catch {done({ok:false,code:"desktop_unavailable"});}
    });
  }

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

  async function uploadBytes(bytes, metadata) {
    const access = await socketAccess();
    if (!access.ok) return access;
    return new Promise((resolve) => {
      let finished = false;
      let sent = false;
      let ws;
      const video = metadata.media_kind === "video";
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
      const timer = setTimeout(disconnected, video ? VIDEO_UPLOAD_TIMEOUT_MS : UPLOAD_TIMEOUT_MS);
      const send = () => {
        ws.send(JSON.stringify({ type: "save_blob", ...metadata, ...(video ? {byte_length:bytes.byteLength} : {}) }));
        ws.send(bytes);
        sent = true;
      };
      try {
        ws = new WebSocket("ws://127.0.0.1:39871/ws", access.protocols);
        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
          try {
            if(video) ws.send(JSON.stringify({type:"ping"}));
            else send();
          } catch { disconnected(); }
        };
        ws.onmessage = (event) => {
          try {
            const result = JSON.parse(event.data);
            if(video && !sent) {
              if(result.capabilities?.video_blob !== true) {finish({ok:false,code:"desktop_upgrade"});return;}
              if(bytes.byteLength > videoLimit(result.capabilities)) {finish({ok:false,code:"too_large"});return;}
              send();return;
            }
            if (typeof result?.ok !== "boolean") throw new Error("invalid receipt");
            if(video && result.ok && result.media_kind!=="video") {finish({ok:false,code:"result_unknown"});return;}
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
      const video=item.media_kind==="video";
      const timer = setTimeout(() => finish({ ok: false, code: "result_unknown" }), video ? VIDEO_FETCH_TIMEOUT_MS+VIDEO_UPLOAD_TIMEOUT_MS+5000 : MESSAGE_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage({
          type: video ? "save_video" : "save_image",
          url: item.media_url,
          pageUrl: item.source_url || "",
          candidateKind: item.candidate_kind || "image-url",
          candidateSource: item.candidate_source || "unknown",
          mediaKind: item.media_kind || "image",
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

  function failureMessage(result, mediaKind = "image") {
    if(result?.code==="pair_required") return "请打开扩展选项，将配对码粘贴到 Bowerbird 的浏览器插件设置中。";
    if(mediaKind==="video") {
      if(result?.saved===true) return result.code==="preview_unavailable" ? "视频已保存，预览暂不可用，请在素材库重新打开。" : "视频已保存，请在素材库查看。";
      if(result?.code==="desktop_upgrade") return "当前桌面端尚不支持插件视频采集，请更新并重启 Bowerbird 后再试。";
      if(result?.code==="desktop_unavailable") return "请启动桌面应用，检查插件配对后再采集视频。";
      if(result?.code==="unsupported_stream") return "该视频使用分段播放或直播，暂不支持直接采集，请使用视频文件链接。";
      if(result?.code==="protected_video") return "该视频受播放保护，暂不支持采集。";
      if(result?.code==="too_large") return "视频超过 200 MiB，请选择较小的视频。";
      if(result?.code==="result_unknown") return "视频保存结果尚未确认，请先查看桌面素材库，不要重复采集。";
      if(result?.code==="reload_extension") return "扩展已更新或失效，请重新加载扩展并刷新网页后再试。";
      if(result?.code==="fetch_timeout") return "读取视频超时，请检查网络后再试。";
      if(result?.code==="invalid_video") return "未读取到完整的视频文件，请刷新网页或使用视频文件链接。";
      if(result?.code==="incomplete_video") return "网站只返回了部分视频，请使用完整视频文件链接。";
      return "视频未能采集，请确认网页中可以播放、桌面应用正常运行后再试。";
    }
    if (result?.code === "desktop_upgrade") return "请更新并重启 Bowerbird，再采集未保存的图片。";
    if (result?.code === "result_unknown") return "部分图片的保存结果尚未确认，请先查看桌面素材库，不要重复采集。";
    if (result?.code === "reload_extension") return "扩展已更新或失效，请重新加载扩展并刷新网页后再试。";
    const error = String(result?.error || "");
    if (result?.code === "desktop_unavailable" || /无法连接.*桌面|ECONNREFUSED/.test(error)) {
      return "请启动桌面应用，检查插件配对后再采集未保存的图片。";
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
    VIDEO_FETCH_TIMEOUT_MS, VIDEO_UPLOAD_TIMEOUT_MS, checkVideoSupport,
    limitBatch, uploadBytes, requestBackground, runBatch, failureMessage, progressMessage,
  };
})(globalThis);
