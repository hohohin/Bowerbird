// No Tauri IPC or library access is exposed to the remote page. The local drop
// target is the only place that can request a capture. Trusted drag events can
// send a private, non-navigating preview notice; they cannot write library data.
(() => {
  if (window.__bowerbirdExplorerInstalled) return;
  window.__bowerbirdExplorerInstalled = true;
  let pressed = null;
  let pointerStarted = false;
  const bridge = "__BOWERBIRD_DRAG_BRIDGE__";
  const openNotice = window.open.bind(window);
  const notifyDrag = (kind, data) => {
    if (!bridge.startsWith("bowerbird-explorer://")) return;
    // Native on_new_window handles and denies this request. The source document
    // never enters a pending navigation (including in WebView2's drag loop).
    try { openNotice(bridge + "/" + kind + "?data=" + encodeURIComponent(JSON.stringify(data)), "_blank"); } catch { /* capture still works */ }
  };
  let dragId = null;
  let visual = null;
  window.addEventListener("dragover", event => visual?.move(event.clientX, event.clientY), true);
  window.addEventListener("dragleave", event => { if (!event.relatedTarget) visual?.hide(); }, true);
  window.addEventListener("pagehide", () => visual?.clear());
  function clearPressed() {
    if (pressed) {
      const { handle, draggable, userDrag, priority } = pressed;
      if (draggable === null) handle.removeAttribute("draggable"); else handle.setAttribute("draggable", draggable);
      if (userDrag) handle.style.setProperty("-webkit-user-drag", userDrag, priority); else handle.style.removeProperty("-webkit-user-drag");
    }
    pressed = null;
    pointerStarted = false;
  }
  function visibleMedia(element) {
    if (!(element instanceof HTMLImageElement || element instanceof HTMLVideoElement)) return false;
    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || parseFloat(style.opacity) <= 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function isPosterFor(image, video) {
    if (!(image instanceof HTMLImageElement) || (image.currentSrc || image.src) !== video.poster) return false;
    for (let card = image.parentElement, depth = 0; card && card !== document.body && depth < 4; card = card.parentElement, depth++) {
      if (card.contains(video)) return true;
    }
    return false;
  }
  function containsPoint(rect, point) {
    return point.clientX >= rect.left && point.clientX < rect.right && point.clientY >= rect.top && point.clientY < rect.bottom;
  }
  function textAtPoint(element, point) {
    if (element.matches("img,video")) return false;
    return [...element.childNodes].some(node => {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) return false;
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].some(rect => containsPoint(rect, point));
    });
  }
  function passThrough(element, point) {
    if (textAtPoint(element, point) || element.matches('button,input,textarea,select,[contenteditable],dialog,[role="dialog"],[aria-modal="true"]')) return false;
    const style = getComputedStyle(element);
    const color = style.backgroundColor;
    const transparent = color === "transparent" || ((color.startsWith("rgba(") || color.includes("/")) && /[,/]\s*0(?:\.0*)?%?\)$/.test(color));
    return style.position !== "fixed" && (Number(style.opacity) === 0
      || (style.backgroundImage === "none" && transparent));
  }
  function reachableMedia(target, media, stack, point) {
    // Keep foreground layers: opaque panels and text cannot expose the feed behind them.
    for (const layer of stack) {
      if (layer === media) break;
      if (!layer.contains(media) && !passThrough(layer, point)) return false;
    }
    // Only empty overlays in the same local card may stand in for its media.
    for (let card = target, depth = 0; card && card !== document.body && depth < 4; card = card.parentElement, depth++) {
      if (card.contains(media)) return true;
      if (!passThrough(card, point)) return false;
    }
    return false;
  }
  function fallbackStack(media, point, stack) {
    if (stack.includes(media) || getComputedStyle(media).pointerEvents !== "none") return stack;
    // Ask the browser for paint order even when a site disables image hit testing.
    // Restore synchronously, before any pointer event can target the image.
    const style = media.getAttribute("style");
    try {
      media.style.setProperty("pointer-events", "auto", "important");
      return document.elementsFromPoint(point.clientX, point.clientY);
    } finally {
      if (style === null) media.removeAttribute("style"); else media.setAttribute("style", style);
    }
  }
  function mediaAtPointer(event) {
    const target = event.target;
    if (!(target instanceof Element) || textAtPoint(target, event) || target.closest("button,input,textarea,select,[contenteditable]:not([contenteditable=false])")) return null;
    const direct = event.composedPath().find(node => node instanceof HTMLVideoElement && visibleMedia(node));
    if (direct) return direct;
    // Note pages with stacked carousels (e.g. Xiaohongshu) keep every slide
    // under the pointer; pick the topmost visible image instead of giving up.
    const stack = document.elementsFromPoint(event.clientX, event.clientY);
    const media = stack.filter(visibleMedia);
    const top = media[0];
    if (top && reachableMedia(target, top, stack, event)) {
      return media.find(element => element.tagName === "VIDEO" && isPosterFor(top, element)) || top;
    }
    // Cards often put a link or transparent div above the image. Resolve only
    // an image under the pointer in that card, never the first image on the page.
    for (let card = target, depth = 0; card && card !== document.body && depth < 4; card = card.parentElement, depth++) {
      const images = [...card.querySelectorAll("video,img")].filter(image => {
        const rect = image.getBoundingClientRect();
        return visibleMedia(image) && containsPoint(rect, event) && reachableMedia(target, image, fallbackStack(image, event, stack), event);
      });
      const videos = images.filter(image => image.tagName === "VIDEO" && visibleMedia(image));
      if (videos.length === 1) return videos[0];
      if (videos.length > 1) return null;
      if (images.length === 1) return images[0];
      if (images.length > 1) return images.filter(visibleMedia).pop() || null;
      if (!passThrough(card, event)) break;
    }
    return null;
  }
  window.addEventListener("pointerdown", event => {
    clearPressed();
    pointerStarted = true;
    if (event.button !== 0) return;
    const image = mediaAtPointer(event);
    if (!image) return;
    const handle = event.target;
    pressed = { image, handle, draggable: handle.getAttribute("draggable"),
      userDrag: handle.style.getPropertyValue("-webkit-user-drag"), priority: handle.style.getPropertyPriority("-webkit-user-drag") };
    // draggable alone cannot override a site's -webkit-user-drag:none.
    handle.draggable = true;
    handle.style.setProperty("-webkit-user-drag", "element", "important");
  }, true);
  window.addEventListener("pointerup", clearPressed, true);
  window.addEventListener("dragend", clearPressed, true);
  window.addEventListener("dragend", event => {
    visual?.clear();
    if (event.isTrusted && dragId) notifyDrag("end", { id: dragId });
    dragId = null;
  }, true);
  // Install on window before site scripts: a site's window capture handler runs
  // before any document handler and can otherwise cancel the drag first.
  window.addEventListener("dragstart", (event) => {
    const image = pointerStarted
      ? pressed && (pressed.handle === event.target || event.target.contains?.(pressed.handle)) && pressed.image
      : mediaAtPointer(event);
    if (!image || !event.dataTransfer) return;
    const candidates = window.BowerbirdCandidates;
    // Match the extension's explicit high-resolution / lazy-source preference.
    const srcset = image.getAttribute("srcset") || image.getAttribute("data-srcset") || image.getAttribute("data-lazy-srcset");
    const selected = candidates?.parseSrcset(srcset, document.baseURI);
    const lazy = image.getAttribute("data-src") || image.getAttribute("data-original") || image.getAttribute("data-lazy-src");
    const video = image instanceof HTMLVideoElement;
    const sources = video ? [image.currentSrc, image.src, ...Array.from(image.querySelectorAll("source[src]"), source => source.src)] : [];
    const imageUrl = video ? sources.find(url => /^https?:/i.test(url)) || sources.find(url => /^blob:/i.test(url))
      : selected?.url || candidates?.normalizeCandidateUrl(lazy, document.baseURI)?.url || image.currentSrc || image.src;
    if (!imageUrl || !(video ? /^(https?:|blob:)/i : /^https?:/i).test(imageUrl)) return;
    const posterUrl = video && /^https?:/i.test(image.poster) ? image.poster : undefined;
    let pageUrl = location.href;
    const link = event.target.closest?.("a[href]") || image.closest("a[href]");
    if (link) {
      try { const target = new URL(link.href); if (target.origin === location.origin) pageUrl = target.href; } catch { /* use current page */ }
    }
    if (video) window.__bbSourceVideo?.remember(image, imageUrl, pageUrl);
    dragId = event.isTrusted && bridge.startsWith("bowerbird-explorer://")
      ? [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, "0")).join("") : null;
    const media = { imageUrl, pageUrl, ...(video ? { mediaKind: "video", ...(posterUrl ? { posterUrl } : {}) } : {}) };
    const payload = JSON.stringify({ version: 1, ...media, ...(dragId ? { dragId } : {}), ...(video && image.mediaKeys ? { blocked: "protected_video" } : {}) });
    event.dataTransfer.setData("application/x-bowerbird-explorer", payload);
    // Native WebView drag bridges may retain only standard text formats.
    event.dataTransfer.setData("text/plain", "bowerbird-explorer:" + payload);
    event.dataTransfer.effectAllowed = "copy";
    if (event.isTrusted && window.createBowerbirdDragVisual) {
      visual ??= window.createBowerbirdDragVisual();
      visual.pick({ id: dragId, imageUrl: video ? posterUrl : image.currentSrc || image.src, mediaKind: video ? "video" : "image" }, event.clientX, event.clientY, image.getBoundingClientRect());
      // A live DOM card can animate and carry tags; the OS drag bitmap cannot.
      const transparent = document.createElement("canvas");
      transparent.width = transparent.height = 1;
      event.dataTransfer.setDragImage(transparent, 0, 0);
    }
    // Keep site drag handlers from replacing the capture payload or cancelling it.
    event.stopImmediatePropagation();
    if (dragId) notifyDrag("start", { id: dragId, ...media });
  }, true);
})();
