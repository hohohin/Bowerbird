// Keep Pinterest's own results, links and masonry; adapt only the Lens page shell.
(() => {
  const origin = location.origin;
  if (window.top !== window || (origin !== "https://www.pinterest.com" && origin !== "https://pinterest.com")) return;
  if (window.__bowerbirdPinterestLayout) return;
  window.__bowerbirdPinterestLayout = true;

  const attribute = "data-bowerbird-lens";
  const style = document.createElement("style");
  style.textContent = `
    [data-bowerbird-lens="layout"] {
      flex-direction: column !important; align-items: stretch !important;
      width: 100% !important; min-width: 0 !important; max-width: 100% !important;
      box-sizing: border-box !important; gap: 12px !important;
    }
    [data-bowerbird-lens="source"], [data-bowerbird-lens="image-box"] {
      position: relative !important; inset: auto !important;
      width: 100% !important; min-width: 0 !important; max-width: 100% !important;
      height: auto !important; min-height: 0 !important; max-height: none !important;
      margin: 0 !important; padding: 0 !important; box-sizing: border-box !important;
      overflow: visible !important;
    }
    [data-bowerbird-lens="image"] {
      display: block !important; position: static !important;
      width: auto !important; height: auto !important;
      max-width: 100% !important; max-height: 160px !important;
      margin: 0 auto !important; object-fit: contain !important;
    }
    [data-bowerbird-lens="placeholder"],
    [data-bowerbird-lens="source"] > :not(:first-child),
    [data-bowerbird-lens="source"] [data-test-id="visual-search-cropper"] {
      display: none !important;
    }
    [data-bowerbird-lens="results"] {
      width: 100% !important; min-width: 0 !important; max-width: 100% !important;
      flex: 0 0 auto !important;
    }
  `;
  let marked = [];
  let frame = 0;

  function findParts() {
    if (location.pathname !== "/lens-search/" && location.pathname !== "/lens-search") return null;
    const source = document.querySelector('[data-test-id="visual-search-image-container"]');
    return source?.parentElement ? partsForSource(source) : null;
  }

  function partsForSource(source) {
    const parent = source.parentElement;
    const siblings = [...parent.children];
    const placeholder = siblings.find(node => node.matches('[data-test-id="visual-search-image-container-placeholder"]'));
    const results = siblings.filter(node => node !== source && node !== placeholder);
    const image = source.firstElementChild?.querySelector("img");
    if (!placeholder || results.length !== 1 || !image) return null;
    const parts = [[parent, "layout"], [source, "source"], [placeholder, "placeholder"], [results[0], "results"], [image, "image"]];
    for (let node = image.parentElement; node !== source; node = node.parentElement) parts.push([node, "image-box"]);
    return parts;
  }

  function clear() {
    for (const node of marked) node.removeAttribute(attribute);
    marked = [];
    style.remove();
  }

  function mark(node, role) {
    node.setAttribute(attribute, role);
    marked.push(node);
  }

  function update() {
    frame = 0;
    const parts = findParts();
    if (!parts) return clear();
    if (style.isConnected && parts.length === marked.length && parts.every(([node], index) => marked[index] === node)) return;
    clear();
    for (const [node, role] of parts) mark(node, role);
    (document.head || document.documentElement).append(style);
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }

  // Lens and Pin navigation is normally same-document; no new WebView load occurs.
  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    history[name] = function (...args) {
      const result = Reflect.apply(original, this, args);
      schedule();
      return result;
    };
  }
  new MutationObserver(schedule).observe(document, { childList: true, subtree: true });
  window.addEventListener("popstate", schedule);
  schedule();
})();
