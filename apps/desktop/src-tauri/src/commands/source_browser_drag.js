// No Tauri IPC or library access is exposed to the remote page. The local drop
// target is the only place that can request a capture.
(() => {
  if (window.__bowerbirdExplorerInstalled) return;
  window.__bowerbirdExplorerInstalled = true;
  let pressed = null;
  function clearPressed() {
    if (pressed) {
      const { handle, draggable, userDrag, priority } = pressed;
      if (draggable === null) handle.removeAttribute("draggable"); else handle.setAttribute("draggable", draggable);
      if (userDrag) handle.style.setProperty("-webkit-user-drag", userDrag, priority); else handle.style.removeProperty("-webkit-user-drag");
    }
    pressed = null;
  }
  function imageAtPointer(event) {
    const direct = event.composedPath().find(node => node?.tagName === "IMG");
    if (direct) return direct;
    // Cards often put a link or transparent div above the image. Resolve only
    // an image under the pointer in that card, never the first image on the page.
    const target = event.target;
    if (!(target instanceof Element) || target.closest("button,input,textarea,select,[contenteditable=true]")) return null;
    for (let card = target, depth = 0; card && card !== document.body && depth < 4; card = card.parentElement, depth++) {
      const images = [...card.querySelectorAll("img")].filter(image => {
        const rect = image.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX < rect.right
          && event.clientY >= rect.top && event.clientY < rect.bottom;
      });
      if (images.length === 1) return images[0];
      if (images.length > 1) return null;
    }
    return null;
  }
  window.addEventListener("pointerdown", event => {
    clearPressed();
    if (event.button !== 0) return;
    const image = imageAtPointer(event);
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
  // Install on window before site scripts: a site's window capture handler runs
  // before any document handler and can otherwise cancel the drag first.
  window.addEventListener("dragstart", (event) => {
    const image = pressed && (pressed.handle === event.target || event.target.contains?.(pressed.handle))
      ? pressed.image : imageAtPointer(event);
    if (!image || !event.dataTransfer) return;
    const candidates = window.BowerbirdCandidates;
    // Match the extension's explicit high-resolution / lazy-source preference.
    const srcset = image.getAttribute("srcset") || image.getAttribute("data-srcset") || image.getAttribute("data-lazy-srcset");
    const selected = candidates?.parseSrcset(srcset, document.baseURI);
    const lazy = image.getAttribute("data-src") || image.getAttribute("data-original") || image.getAttribute("data-lazy-src");
    const imageUrl = selected?.url || candidates?.normalizeCandidateUrl(lazy, document.baseURI)?.url || image.currentSrc || image.src;
    if (!/^https?:/i.test(imageUrl)) return;
    let pageUrl = location.href;
    const link = event.target.closest?.("a[href]") || image.closest("a[href]");
    if (link) {
      try { const target = new URL(link.href); if (target.origin === location.origin) pageUrl = target.href; } catch { /* use current page */ }
    }
    const payload = JSON.stringify({ version: 1, imageUrl, pageUrl });
    event.dataTransfer.setData("application/x-bowerbird-explorer", payload);
    // Native WebView drag bridges may retain only standard text formats.
    event.dataTransfer.setData("text/plain", "bowerbird-explorer:" + payload);
    event.dataTransfer.effectAllowed = "copy";
    // Keep site drag handlers from replacing the capture payload or cancelling it.
    event.stopImmediatePropagation();
  }, true);
})();
