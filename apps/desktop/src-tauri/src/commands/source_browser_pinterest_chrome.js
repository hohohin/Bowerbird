// Adapt Pinterest's page chrome; preserve its content, navigation and popovers.
(() => {
  if (window.top !== window || (location.origin !== "https://www.pinterest.com" && location.origin !== "https://pinterest.com")) return;
  if (window.__bowerbirdPinterestChrome) return;
  window.__bowerbirdPinterestChrome = true;
  const rules = __BOWERBIRD_SITE_RULES__;
  const pin = rules.pinterest;
  const testId = value => `[data-test-id="${value}"]`;
  const hiddenToolbar = pin.hiddenToolbarItems.map(testId).join(", ");
  const navSelector = `html[data-bowerbird-pin-nav] #${CSS.escape(pin.toolbarId)}`;
  const navIcon = `${navSelector} ${testId(pin.toolbarIcon)}`;
  __BOWERBIRD_SCROLLBAR_RUNTIME__
  const style = document.createElement("style");
  style.dataset.bowerbirdPinterestChrome = "";
  style.textContent = __BOWERBIRD_SCROLLBAR_CSS__ + `
    ${hiddenToolbar} { display: none !important; }
    button.industrial-scrollbar { --bb-muted: var(--sema-color-text-subtle, #646464); }
    ${navSelector} {
      position: fixed !important; inset: auto !important; inset-inline-start: 8px !important;
      top: 50% !important; transform: translateY(-50%) !important;
      box-sizing: border-box !important; width: 36px !important; min-width: 0 !important;
      height: fit-content !important; min-height: 0 !important; max-height: calc(100% - 16px) !important;
      overflow-y: auto !important; scrollbar-width: none;
      padding: 4px 0 !important; border: 1px solid var(--sema-color-border-default, #8886) !important;
      border-radius: 12px !important; background: var(--sema-color-background-default, Canvas) !important;
      box-shadow: 0 3px 12px #0002;
    }
    ${navSelector} > div { height: auto !important; padding: 0 !important; }
    ${navIcon} {
      width: 32px !important; max-width: 32px !important; margin-inline: auto !important;
    }
    ${navSelector} :is(a, button) {
      max-width: 32px !important; min-width: 0 !important; padding-inline: 4px !important; box-sizing: border-box !important;
    }
    ${navSelector} :focus-visible {
      outline: 2px solid currentColor !important; outline-offset: -2px !important;
    }
    ${navSelector} svg,
    ${navIcon} img {
      width: 16px !important; height: 16px !important; flex-shrink: 0 !important; object-fit: contain !important;
    }
    html[data-bowerbird-pin-nav] [data-bowerbird-pin-inset] { padding-inline-start: var(--bowerbird-pin-inset) !important; }
    html[data-bowerbird-pin-nav] ${testId(pin.sidebar)} { margin-inline-start: 52px !important; }
  `;
  let frame = 0;
  let marked = new Set();

  function markInset(parent, side) {
    // Pinterest owns the inline inset, including any expanded native sidebar.
    const inset = Number.parseFloat(parent?.style[side]);
    if (!parent || !Number.isFinite(inset) || inset < 72) return false;
    // The feed uses the full width. An open drawer clears the floating rail
    // (8px gap + 36px toolbar + 8px gap) and retains its own native width.
    const value = `${inset === 72 ? 0 : inset - 72 + 52}px`;
    if (parent.style.getPropertyValue("--bowerbird-pin-inset") !== value) parent.style.setProperty("--bowerbird-pin-inset", value);
    if (!parent.hasAttribute("data-bowerbird-pin-inset")) parent.setAttribute("data-bowerbird-pin-inset", "");
    return true;
  }
  function contentInsets(nav) {
    const next = new Set();
    if (!nav) return next;
    const side = getComputedStyle(nav).direction === "rtl" ? "paddingRight" : "paddingLeft";
    for (const main of document.querySelectorAll(`.${CSS.escape(pin.mainClass)}`)) {
      if (markInset(main.parentElement, side)) next.add(main.parentElement);
    }
    return next;
  }
  function update() {
    frame = 0;
    const nav = document.getElementById(pin.toolbarId);
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
