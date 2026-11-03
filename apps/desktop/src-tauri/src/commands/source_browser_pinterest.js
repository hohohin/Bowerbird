// Only Pinterest's Lens upload control may receive the explicitly selected image.
(() => {
  const origin = location.origin;
  if (window.top !== window || (origin !== "https://www.pinterest.com" && origin !== "https://pinterest.com")) return;
  const request = __BOWERBIRD_PINTEREST_REQUEST__;
  // A late load event must not feed a new image to an old, still-busy uploader.
  if (performance.timeOrigin < request.documentAfter) return;
  const bridge = "__BOWERBIRD_PINTEREST_BRIDGE__";
  const previous = window.__bowerbirdPinterestSearch;
  if (previous?.requestId === request.requestId) return;
  previous?.cancel();
  let stopped = false;
  let lastStatus = "";
  let timer;
  const started = Date.now();
  let uploaderStarted = null;
  let lensClickedAt = null;
  let handedOff = !!request.handedOff;
  let uploadStarted = handedOff ? started : null;

  function cancel(requestId) {
    if (requestId && requestId !== request.requestId) return;
    stopped = true;
    clearInterval(timer);
    request.base64 = "";
  }
  window.__bowerbirdPinterestSearch = { requestId: request.requestId, cancel };
  function report(status, message) {
    if (stopped || lastStatus === status) return;
    lastStatus = status;
    window.open(`${bridge}/status?data=${encodeURIComponent(JSON.stringify({ requestId: request.requestId, status, ...(message ? { message } : {}) }))}`);
  }
  function fail(message) {
    report("error", message);
    cancel();
  }
  function loggedOut() {
    if (document.querySelector('input[type="password"]')) return true;
    // Pinterest can log in without replacing the initial JSON document.
    if (document.querySelector('button[aria-label="Lens"]')) return false;
    try {
      return JSON.parse(document.getElementById("__PWS_DATA__")?.textContent || "{}").context?.is_authenticated === false;
    } catch { return false; }
  }
  function handoff(input) {
    try {
      const bytes = Uint8Array.from(atob(request.base64), value => value.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], request.name, { type: request.mime }));
      handedOff = true;
      uploadStarted = Date.now();
      request.base64 = "";
      report("searching");
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {
      fail("图片未能交给搜索网页，请重新发起以图搜图。");
    }
  }
  function followUpload() {
    if (location.pathname === "/lens-search/" || location.pathname === "/lens-search") {
      report("submitted");
      cancel();
    } else if (document.querySelector('#lens-file-upload[aria-invalid="true"]')) {
      fail("网页未能接收这张图片，请重新发起以图搜图。");
    } else if (Date.now() - uploadStarted > 120_000) {
      fail("网页尚未完成图片搜索，请检查网络后重试。");
    }
  }
  function openLens() {
    if (document.querySelector('[aria-label="Lens popover"], [data-test-id="lens-file-upload"]')) return;
    const lens = document.querySelector('button[aria-label="Lens"]');
    if (!lens || lens.disabled || !lens.getClientRects().length) return;
    // A server-rendered button may precede its React click handler.
    if (lensClickedAt !== null && Date.now() - lensClickedAt < 1000) return;
    lensClickedAt = Date.now();
    lens.click();
  }
  function tick() {
    if (stopped) return;
    if (Date.now() - started > 600_000) return fail("此次搜图等待已结束，请重新发起以图搜图。");
    if (handedOff) return followUpload();
    const input = document.querySelector('input#lens-file-upload[type="file"][data-test-id="lens-file-upload"]');
    if (input && !input.disabled && !document.querySelector('input[type="password"]')) return handoff(input);
    if (loggedOut()) {
      uploaderStarted = null;
      report("waiting-login");
      return;
    }
    uploaderStarted ??= Date.now();
    openLens();
    if (Date.now() - uploaderStarted > 30_000) fail("未找到网页的图片搜索入口，请稍后重试。");
  }
  timer = setInterval(tick, 250);
  tick();
})();
