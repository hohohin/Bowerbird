// Bowerbird content script. Prepare current-page candidates and coordinate user actions.
(() => {
  "use strict";
  if (window.__bowerbirdInjected) return;
  window.__bowerbirdInjected = true;

  const S = globalThis.BowerbirdCollection;
  const V = globalThis.BowerbirdVideo;
  const C = globalThis.BowerbirdCandidates;
  const site = globalThis.BowerbirdXiaohongshu;
  const { trackVideoDrag, collectVideos, savePageVideo } = globalThis.BowerbirdContentVideo;
  const { onUserAction, MENU_ID, SETTINGS_ID } = globalThis.BowerbirdOverlay;
  const { makeGenericBatch, candidatesFromDropEvent, collectGenericCandidates, imageAtPoint, addElementImageCandidates, cssBackgroundCandidates } = globalThis.BowerbirdScanner;
  const CONFIRM_ID = "__bowerbird_confirm";
  const VIDEO_ID = "__bowerbird_videos";
  const handledDrops = new WeakSet();
  let collecting = false;
  let scanning = false;
  let siteHidden = false;
  let visibilityRevision = 0;

  const overlay = globalThis.BowerbirdOverlay.create({
    getBusy: () => collecting || scanning,
    onButton: () => panels.toggleMenu(),
    onDrop: handleDrop,
  });
  const { btn } = overlay;
  const videoFromDrop = trackVideoDrag(onUserAction);
  const panels = globalThis.BowerbirdPanels.create(overlay, {
    startImageScan, startVideoScan, saveVideo, hideConfirm, setSiteHidden,
    isHidden: () => siteHidden,
  });

  function requestSetting(message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, reply => resolve(chrome.runtime.lastError ? null : reply));
      } catch { resolve(null); }
    });
  }

  function showSiteVisibility(hidden) {
    siteHidden = hidden;
    overlay.setVisibility(!hidden);
  }

  async function getSiteHidden() {
    const revision = visibilityRevision;
    const reply = await requestSetting({ type: "site_visibility_get" });
    if (revision === visibilityRevision && reply?.ok) showSiteVisibility(reply.hidden);
  }

  async function setSiteHidden(hidden) {
    const revision = ++visibilityRevision;
    const reply = await requestSetting({ type: "site_visibility_set", hidden });
    if (revision !== visibilityRevision || !reply?.ok) return false;
    showSiteVisibility(reply.hidden);
    return true;
  }

  void getSiteHidden();
  window.addEventListener("focus", getSiteHidden);
  chrome.runtime.onMessage?.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab || message?.type !== "bowerbird_toolbar_action") return;
    if (siteHidden) {
      showSiteVisibility(false);
      void setSiteHidden(false);
    } else if (!collecting && !scanning) {
      panels.toggleMenu();
    }
  });

  // The background shares a single in-flight ping and cooldown by browser install.
  let heartbeatTimer = 0;
  function heartbeat() {
    clearTimeout(heartbeatTimer);
    if (document.visibilityState !== "visible") return;
    try {
      chrome.runtime.sendMessage({ type: "collect_heartbeat" }, reply => {
        void chrome.runtime.lastError;
        if (document.visibilityState !== "visible") return;
        clearTimeout(heartbeatTimer);
        heartbeatTimer = setTimeout(heartbeat, Math.max(500, reply?.retryAfterMs ?? 15000));
      });
    } catch { /* The extension may have reloaded while this page remains open. */ }
  }
  document.addEventListener("visibilitychange", heartbeat);
  heartbeat();

  onUserAction(document, "pointerdown", event => {
    if (overlay.ownsEvent(event)) return;
    panels.closeMenu();
    panels.closeSettings();
  }, true);
  onUserAction(document, "keydown", event => {
    if (event.key !== "Escape") return;
    if (overlay.root.getElementById(MENU_ID)) {
      event.preventDefault();
      panels.closeMenu({ focus: true });
    } else if (overlay.root.getElementById(SETTINGS_ID)) {
      event.preventDefault();
      panels.closeSettings({ focus: true });
    } else if (overlay.root.getElementById(VIDEO_ID) || overlay.root.getElementById(CONFIRM_ID)) {
      event.preventDefault();
      overlay.remove(VIDEO_ID);
      hideConfirm();
      btn.focus();
      overlay.scheduleCollapse();
    }
  }, true);

  function hideConfirm() {
    overlay.remove(CONFIRM_ID);
  }

  function handleDrop(event) {
    if (handledDrops.has(event.dataTransfer)) return;
    handledDrops.add(event.dataTransfer);
    const video = videoFromDrop(event);
    if (video) { void saveVideo(video); return; }
    const candidates = candidatesFromDropEvent(event);
    if (candidates.length) void saveBatch(makeGenericBatch(candidates));
    else panels.showToast("未识别到可采集的图片或视频", false);
  }

  async function startImageScan() {
    if (collecting || scanning) return;
    scanning = true;
    btn.disabled = true;
    try {
      const siteBatch = await site.collectImages();
      const batch = S.limitBatch(siteBatch?.items.length ? siteBatch : makeGenericBatch(collectGenericCandidates()));
      if (batch.items.length) showImagePicker(batch);
      else panels.showToast("未发现可采集素材", false);
    } catch (error) {
      panels.showToast(S.failureMessage({ error: String(error) }), false, 12000);
    } finally {
      scanning = false;
      btn.disabled = collecting;
      overlay.scheduleCollapse();
    }
  }

  async function startVideoScan() {
    if (collecting || scanning) return;
    scanning = true;
    btn.disabled = true;
    try {
      panels.showVideos(await collectVideos());
    } catch {
      panels.showToast("未能读取页面视频，请刷新网页后再试。", false, 10000);
    } finally {
      scanning = false;
      btn.disabled = collecting;
      overlay.scheduleCollapse();
    }
  }

  function beginCollecting() {
    collecting = true;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    hideConfirm();
    panels.closeMenu();
    panels.closeSettings();
    overlay.remove(VIDEO_ID);
  }

  function finishCollecting() {
    collecting = false;
    btn.disabled = false;
    btn.setAttribute("aria-busy", "false");
    overlay.scheduleCollapse();
  }

  async function saveVideo(item) {
    if (collecting || scanning) return;
    if (item.blocked) {
      panels.showToast(S.failureMessage({ code: item.blocked }, "video"), false, 12000);
      return;
    }
    beginCollecting();
    panels.showToast("正在采集视频，请保持网页打开…", true, 0);
    try {
      const result = /^(blob:|data:)/i.test(item.media_url) ? await savePageVideo(item) : await S.requestBackground(item);
      panels.showToast(result.ok ? "视频已保存到素材库" : S.failureMessage(result, "video"), result.ok || result.saved, 12000);
    } catch {
      panels.showToast("视频未能采集，请刷新网页后再试。", false, 12000);
    } finally {
      finishCollecting();
    }
  }

  function showImagePicker(batch) {
    panels.closeSettings();
    hideConfirm();
    const card = globalThis.BowerbirdImagePicker.create(batch, {
      onUserAction,
      onCancel: () => {
        hideConfirm();
        btn.focus();
        overlay.scheduleCollapse();
      },
      onCollect: items => { void saveBatch({ ...batch, items }); },
    });
    overlay.mount(card);
    card.focus();
  }

  async function uploadLocalBytes(bytes, metadata) {
    if (!bytes || bytes.byteLength === 0) return { ok: false, code: "invalid_image", error: "页面图片字节为空" };
    if (bytes.byteLength > S.MAX_INLINE_BYTES) {
      return { ok: false, code: "too_large", error: "页面内嵌图片超过 20 MiB 上限" };
    }
    return S.uploadBytes(bytes, metadata);
  }

  async function saveLocalCandidate(candidate, pageUrl, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) return { ok: false, code: "cancelled" };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, S.FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(candidate.url, { signal: controller.signal });
      if (!response.ok) return { ok: false, error: `页面读取图片失败：HTTP ${response.status}` };
      if (Number(response.headers.get("content-length")) > S.MAX_INLINE_BYTES) return { ok: false, code: "too_large" };
      let contentType = response.headers.get("content-type") || "";
      let fileName = "page-image";
      let bytes = new Uint8Array(await response.arrayBuffer());
      controller.signal.throwIfAborted();
      if (bytes.byteLength > S.MAX_INLINE_BYTES) return { ok: false, code: "too_large" };
      if (V.bmffImageFormat(bytes) === "avif") {
        const normalized = await V.avifToPng(bytes, S.MAX_INLINE_BYTES, controller.signal);
        if (!normalized.ok) return normalized;
        bytes = normalized.bytes;
        contentType = "image/png";
        fileName = "page-image.png";
      }
      return uploadLocalBytes(bytes.buffer, {
        requested_url: pageUrl,
        effective_url: pageUrl,
        page_url: pageUrl,
        url: pageUrl,
        file_name: fileName,
        content_type: contentType,
        candidate_source: candidate.source,
      });
    } catch (error) {
      return { ok: false, code: signal?.aborted ? "cancelled" : error?.name === "AbortError" ? "fetch_timeout" : "fetch_failed", error: String(error) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
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
      return { ok: false, code: "canvas_blocked", error: String(error) };
    }
  }

  onUserAction(document,
    "click",
    async (e) => {
      if (!e.altKey) return;
      if (collecting || scanning) return;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
      if (overlay.ownsEvent(e)) return;
      const video=path.find(node=>node?.tagName==="VIDEO");
      if(video) {
        e.preventDefault();e.stopPropagation();
        const item=V.element(video,location.href);
        if(item)panels.showVideos([item]);else panels.showToast("未读取到视频地址，请先开始播放后再试。",false,10000);
        return;
      }
      const canvas = path.find((node) => node?.tagName === "CANVAS");
      if (canvas) {
        e.preventDefault();
        e.stopPropagation();
        saveBatch({ items: [{ canvas, source_url: location.href }] });
        return;
      }
      const collectImage = (image) => {
        const out = [];
        addElementImageCandidates(out, image, location.href, 1000);
        return C.rankAndDedupe(out);
      };
      let sourceElement = path.find((node) => node?.tagName === "IMG");
      let candidates = sourceElement ? collectImage(sourceElement) : [];
      if (candidates.length === 0 && (e.clientX || e.clientY)) {
        const pointImage = imageAtPoint(e.clientX, e.clientY);
        if (pointImage && pointImage !== sourceElement) {
          sourceElement = pointImage;
          candidates = collectImage(pointImage);
        }
      }
      if (candidates.length === 0) {
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
      saveBatch(makeGenericBatch(candidates, noteLink || location.href));
    },
    true
  );

  async function saveBatch(batch) {
    if (collecting || !batch.items.length) return;
    const items = batch.items.map(item => ({ ...item, source_url: item.source_url || location.href }));
    const controller = new AbortController();
    const stop = {
      label: "停止",
      run: () => {
        controller.abort();
        panels.showToast("正在停止采集，等待上一次保存回执…", true, 0);
      },
    };
    beginCollecting();
    try {
      const summary = await S.runBatch(items, {
        remote: S.requestBackground,
        local: (item, signal) => saveLocalCandidate({ url: item.media_url, source: item.candidate_source }, item.source_url, signal),
        canvas: (item) => saveCanvas(item.canvas, item.source_url),
      }, progress => {
        if (!controller.signal.aborted) panels.showToast(S.progressMessage(progress), true, 0, items.length > 1 ? stop : null);
      }, { signal: controller.signal });
      const failures = summary.failedItems || [];
      const retry = failures.length ? {
        label: `重试失败项（${failures.length}）`,
        run: () => { void saveBatch({ items: failures }); },
        dismissible: true,
      } : null;
      panels.showToast(S.progressMessage(summary, true), summary.failed === 0 && summary.unconfirmed === 0, retry ? 0 : 12000, retry);
    } finally {
      finishCollecting();
    }
  }
})();
