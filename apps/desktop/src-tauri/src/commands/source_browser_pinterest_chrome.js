// Adapt Pinterest's page chrome; preserve its content, navigation and popovers.
(() => {
  if (window.top !== window || (location.origin !== "https://www.pinterest.com" && location.origin !== "https://pinterest.com")) return;
  if (window.__bowerbirdPinterestChrome) return;
  window.__bowerbirdPinterestChrome = true;
  __BOWERBIRD_SCROLLBAR_RUNTIME__
  const style = document.createElement("style");
  style.dataset.bowerbirdPinterestChrome = "";
  style.textContent = __BOWERBIRD_SCROLLBAR_CSS__ + `
    [data-test-id="PinBetterSaveDropdown"], [data-test-id="PinBetterSaveButton"] { display: none !important; }
    button.industrial-scrollbar { --bb-muted: var(--sema-color-text-subtle, #646464); }
    html[data-bowerbird-pin-nav] #VerticalNavContent { width: 36px !important; min-width: 0 !important; }
    html[data-bowerbird-pin-nav] #VerticalNavContent > div { padding-inline: 0 !important; }
    html[data-bowerbird-pin-nav] #VerticalNavContent [data-test-id="vertical-nav-icon"] {
      width: 32px !important; max-width: 32px !important; margin-inline: auto !important;
    }
    html[data-bowerbird-pin-nav] #VerticalNavContent :is(a, button) {
      max-width: 32px !important; min-width: 0 !important; padding-inline: 4px !important; box-sizing: border-box !important;
    }
    html[data-bowerbird-pin-nav] [data-bowerbird-pin-inset] { padding-inline-start: var(--bowerbird-pin-inset) !important; }
    html[data-bowerbird-pin-nav] [data-test-id="sidebar-container"] { margin-inline-start: 36px !important; }
  `;
  let frame = 0;
  let marked = new Set();

  function markInset(parent, side) {
    // Pinterest owns the inline inset, including any expanded native sidebar.
    const inset = Number.parseFloat(parent?.style[side]);
    if (!parent || !Number.isFinite(inset) || inset < 72) return false;
    const value = `${inset - 36}px`;
    if (parent.style.getPropertyValue("--bowerbird-pin-inset") !== value) parent.style.setProperty("--bowerbird-pin-inset", value);
    if (!parent.hasAttribute("data-bowerbird-pin-inset")) parent.setAttribute("data-bowerbird-pin-inset", "");
    return true;
  }
  function contentInsets(nav) {
    const next = new Set();
    if (!nav) return next;
    const side = getComputedStyle(nav).direction === "rtl" ? "paddingRight" : "paddingLeft";
    for (const main of document.querySelectorAll(".mainContainer")) {
      if (markInset(main.parentElement, side)) next.add(main.parentElement);
    }
    return next;
  }
  function update() {
    frame = 0;
    const nav = document.getElementById("VerticalNavContent");
    const active = !!nav && nav.getClientRects().length > 0;
    document.documentElement.toggleAttribute("data-bowerbird-pin-nav", active);
    const next = contentInsets(active ? nav : null);
    for (const parent of marked) if (!next.has(parent)) {
      parent.removeAttribute("data-bowerbird-pin-inset"); parent.style.removeProperty("--bowerbird-pin-inset");
    }
    marked = next;
  }
  function schedule(records) {
    if (records?.every(record => record.target instanceof Element && record.target.closest("[data-industrial-scrollbar-layer]"))) return;
    if (!frame) frame = requestAnimationFrame(update);
  }
  function start() {
    document.head.append(style);
    window.enableBowerbirdOverlayScrollbars();
    new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "id", "dir", "hidden"] });
    window.addEventListener("resize", () => schedule());
    schedule();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
