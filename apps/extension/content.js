// Bowerbird content script：拖拽、批量采集、Alt+点击单张保存。
// 小红书使用页面结构化数据，其他站点回退到通用 DOM 图片扫描。

(function () {
  if (window.__bowerbirdInjected) return;
  window.__bowerbirdInjected = true;

  const XHS_HOST = "www.xiaohongshu.com";
  const S = globalThis.BowerbirdCollection;
  const V = globalThis.BowerbirdVideo;
  let collecting = false;
  let scanning = false;
  let draggedVideo = null;
  let temporaryDraggable = null;
  const handledDrops = new WeakSet();

  // Content scripts share DOM elements with the page. Accept browser input
  // (including keyboard button activation) at each capture decision.
  function onUserAction(target, type, handler, capture = false) {
    target.addEventListener(type, event => {
      if (event.isTrusted) return handler(event);
    }, capture);
  }

  // 心跳：让桌面端知道扩展已安装且当前浏览器可连接（每 15s 建短连发 ping）。
  // 不影响采集（采集走独立的 save_blob 连接）；桌面端据此显示「扩展已连接」。
  function heartbeat() {
    try {
      chrome.runtime.sendMessage({type:"collect_heartbeat"}, () => { void chrome.runtime.lastError; });
    } catch { /* 桌面端未启动时静默，采集时再给明确提示 */ }
  }
  heartbeat();
  setInterval(heartbeat, 15000);

  // 悬浮入口：可拖动；拖到左右边缘会吸附并自动收起，悬停或聚焦展开。
  // 单击打开二级菜单选择采集本页图片或视频；拖拽图片/视频到按钮仍直接采集。
  const BTN_SIZE = 48;
  const BTN_MARGIN = 24;
  const SNAP_DISTANCE = 16;
  const PEEK = 12;
  const HIDE_DELAY_MS = 1200;
  const DRAG_THRESHOLD = 4;
  const MENU_ID = "__bowerbird_menu";
  const SETTINGS_ID = "__bowerbird_settings";
  const PANEL_WIDTHS = {
    [MENU_ID]: 220,
    [SETTINGS_ID]: 360,
    __bowerbird_confirm: 320,
    __bowerbird_videos: 340,
    __bowerbird_toast: 380,
  };

  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", "Bowerbird 采集菜单");
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.draggable = false;
  const btnLogo = document.createElement("img");
  btnLogo.src = chrome.runtime.getURL("icons/48x48.png");
  btnLogo.alt = "";
  btnLogo.draggable = false;
  btnLogo.style.cssText = "width:100%;height:100%;display:block;pointer-events:none";
  btn.appendChild(btnLogo);
  btn.title = "拖动可调整位置；拖到左右边缘自动收起，悬停展开；点击选择采集图片或视频";
  btn.style.cssText = [
    "position:fixed",
    "width:48px",
    "height:48px",
    "border-radius:12px",
    "border:0",
    "padding:0",
    "background:#0b1026",
    "overflow:hidden",
    "cursor:grab",
    "touch-action:none",
    "user-select:none",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "box-shadow:0 2px 12px rgba(0,0,0,0.35)",
    "opacity:0.85",
    "transition:transform .18s ease,opacity .15s",
  ].join(";");

  function viewportSize() {
    return {
      width: Number(globalThis.innerWidth) || Number(document.documentElement?.clientWidth) || 1024,
      height: Number(globalThis.innerHeight) || Number(document.documentElement?.clientHeight) || 768,
    };
  }
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  function defaultButtonState() {
    const { width, height } = viewportSize();
    return {
      x: Math.max(8, width - BTN_MARGIN - BTN_SIZE),
      y: Math.max(8, height - BTN_MARGIN - BTN_SIZE),
      dock: null,
    };
  }
  let buttonState = defaultButtonState();
  let btnScale = 1;
  let collapsed = false;
  let dragging = false;
  let pointerDrag = null;
  let suppressClick = false;
  let hovering = false;
  let positionCustomized = false;
  let hideTimer = 0;

  function renderButton() {
    const shift = collapsed && buttonState.dock
      ? (buttonState.dock === "left" ? -(BTN_SIZE - PEEK) : BTN_SIZE - PEEK)
      : 0;
    btn.style.left = `${buttonState.x}px`;
    btn.style.top = `${buttonState.y}px`;
    btn.style.right = "auto";
    btn.style.bottom = "auto";
    btn.style.transform = `translateX(${shift}px) scale(${btnScale})`;
    btn.style.cursor = dragging ? "grabbing" : "grab";
    btn.style.opacity = hovering || dragging ? "1" : collapsed ? "0.75" : "0.85";
    btn.setAttribute("aria-expanded", document.getElementById(MENU_ID) ? "true" : "false");
  }

  function panelOpen() {
    return Boolean(
      document.getElementById(MENU_ID) ||
      document.getElementById(SETTINGS_ID) ||
      document.getElementById("__bowerbird_confirm") ||
      document.getElementById("__bowerbird_videos")
    );
  }
  function canAutoCollapse() {
    if (!buttonState.dock || dragging || hovering || collecting || scanning || panelOpen()) return false;
    const active = document.activeElement;
    return !(active && (active === btn || btn.contains?.(active)));
  }
  function clearHideTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
  }
  function scheduleCollapse(delay = HIDE_DELAY_MS) {
    clearHideTimer();
    if (!buttonState.dock || collapsed || !canAutoCollapse()) return;
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      if (canAutoCollapse()) setCollapsed(true);
    }, delay);
  }
  function setCollapsed(value) {
    const next = Boolean(value && buttonState.dock);
    if (next === collapsed) return;
    collapsed = next;
    renderButton();
  }

  function placePanel(panel, maxWidth) {
    const { width, height } = viewportSize();
    panel.style.boxSizing = "border-box";
    panel.style.position = "fixed";
    panel.style.width = `min(${maxWidth}px, calc(100vw - 48px))`;
    panel.style.left = "auto";
    panel.style.right = "auto";
    panel.style.top = "auto";
    panel.style.bottom = "auto";
    const rect = panel.getBoundingClientRect();
    const panelWidth = rect.width || maxWidth;
    const panelHeight = rect.height || 120;
    const left = clamp(buttonState.x + BTN_SIZE - panelWidth, 8, width - panelWidth - 8);
    panel.style.left = `${left}px`;
    const belowTop = buttonState.y + BTN_SIZE + 8;
    const spaceBelow = height - belowTop - 12;
    const spaceAbove = buttonState.y - 8 - 12;
    if (spaceBelow >= Math.min(panelHeight, 220) || spaceBelow >= spaceAbove) {
      panel.style.top = `${belowTop}px`;
      panel.style.maxHeight = `${Math.max(96, spaceBelow)}px`;
    } else {
      panel.style.bottom = `${height - buttonState.y + 8}px`;
      panel.style.maxHeight = `${Math.max(96, spaceAbove)}px`;
    }
    panel.style.overflow = "auto";
  }

  function saveButtonState() {
    positionCustomized = true;
    try {
      chrome.runtime.sendMessage(
        {
          type: "button_position_set",
          position: { x: buttonState.x, y: buttonState.y, dock: buttonState.dock },
        },
        () => { void chrome.runtime.lastError; }
      );
    } catch { /* 后台不可用时只保留本次页面位置 */ }
  }
  function loadButtonState() {
    try {
      chrome.runtime.sendMessage({ type: "button_position_get" }, (response) => {
        if (chrome.runtime.lastError || positionCustomized) return;
        const saved = response?.position;
        if (!saved) return;
        const { width, height } = viewportSize();
        const dock = saved.dock === "left" || saved.dock === "right" ? saved.dock : null;
        const y = Number(saved.y);
        const x = dock === "left" ? 0 : dock === "right" ? width - BTN_SIZE : Number(saved.x);
        if (!Number.isFinite(y) || !Number.isFinite(x)) return;
        buttonState = { x: clamp(x, 0, width - BTN_SIZE), y: clamp(y, 0, height - BTN_SIZE), dock };
        renderButton();
        if (dock) scheduleCollapse();
      });
    } catch { /* 读取失败时沿用默认位置 */ }
  }
  function dockFor(x) {
    const { width } = viewportSize();
    if (x <= SNAP_DISTANCE) return "left";
    if (x + BTN_SIZE >= width - SNAP_DISTANCE) return "right";
    return null;
  }

  function openMenu() {
    closeMenu();
    closeSettings();
    hideConfirm();
    document.getElementById("__bowerbird_videos")?.remove();
    document.getElementById("__bowerbird_toast")?.remove();
    const card = document.createElement("div");
    card.id = MENU_ID;
    card.setAttribute("role", "menu");
    card.setAttribute("aria-label", "Bowerbird 菜单");
    card.style.cssText = [
      "position:fixed",
      "padding:6px",
      "background:#1e1e1e",
      "color:#dcdcdc",
      "border:1px solid #747474",
      "border-radius:8px",
      "font:13px -apple-system,sans-serif",
      "box-shadow:0 6px 20px rgba(0,0,0,0.45)",
      "z-index:2147483647",
    ].join(";");
    const actions = [
      ["采集本页图片", startImageScan],
      ["采集本页视频", startVideoScan],
      ["设置", openSettings],
    ];
    let firstItem = null;
    actions.forEach(([label, run]) => {
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      item.style.cssText = "display:block;width:100%;padding:9px 12px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;text-align:left;white-space:nowrap;cursor:pointer";
      if (label === "设置") {
        item.style.marginTop = "4px";
        item.style.borderTop = "1px solid #3d3d3d";
        item.style.borderRadius = "0 0 5px 5px";
        item.style.boxSizing = "border-box";
      }
      item.addEventListener("mouseenter", () => (item.style.background = "#2f2f2f"));
      item.addEventListener("mouseleave", () => (item.style.background = "transparent"));
      onUserAction(item, "click", () => {
        closeMenu();
        run();
      });
      card.append(item);
      if (!firstItem) firstItem = item;
    });
    document.documentElement.appendChild(card);
    placePanel(card, PANEL_WIDTHS[MENU_ID]);
    btn.setAttribute("aria-expanded", "true");
    firstItem?.focus?.();
  }
  function closeMenu(options = {}) {
    document.getElementById(MENU_ID)?.remove();
    btn.setAttribute("aria-expanded", "false");
    if (options.focus) btn.focus?.();
    scheduleCollapse();
  }
  function toggleMenu() {
    if (document.getElementById(MENU_ID)) {
      closeMenu({ focus: true });
      return;
    }
    if (document.getElementById(SETTINGS_ID)) {
      closeSettings({ focus: true });
      return;
    }
    openMenu();
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* 页面拒绝剪贴板 API 时回退到选区复制 */ }
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
      document.documentElement.appendChild(area);
      try {
        area.focus();
        area.select();
        return document.execCommand("copy");
      } finally {
        area.remove();
      }
    } catch { return false; }
  }

  function resetButtonPosition() {
    buttonState = defaultButtonState();
    collapsed = false;
    clearHideTimer();
    renderButton();
    saveButtonState();
  }

  function openSettings() {
    closeMenu();
    hideConfirm();
    document.getElementById("__bowerbird_videos")?.remove();
    document.getElementById("__bowerbird_toast")?.remove();
    document.getElementById(SETTINGS_ID)?.remove();

    const card = document.createElement("section");
    card.id = SETTINGS_ID;
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Bowerbird 设置");
    card.tabIndex = -1;
    card.style.cssText = "position:fixed;padding:16px;background:#1e1e1e;color:#dcdcdc;border:1px solid #747474;border-radius:8px;font:13px -apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.45);z-index:2147483647";

    const heading = document.createElement("div");
    heading.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:14px";
    const title = document.createElement("strong");
    title.textContent = "设置";
    title.style.cssText = "font-size:14px;font-weight:600";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.style.cssText = "background:none;border:0;color:#a9a9a9;cursor:pointer;padding:4px 6px;font:inherit";
    close.onclick = () => closeSettings({ focus: true });
    heading.append(title, close);
    card.append(heading);

    const pairLabel = document.createElement("div");
    pairLabel.textContent = "配对码";
    pairLabel.style.cssText = "font-size:12px;color:#8faab8;margin-bottom:6px";
    const codeBox = document.createElement("div");
    codeBox.id = "__bowerbird_pairing_code";
    codeBox.setAttribute("aria-label", "配对码");
    codeBox.style.cssText = "padding:8px;background:#141414;border:1px solid #3d3d3d;border-radius:5px;color:#dcdfe4;font:11px ui-monospace,SFMono-Regular,Consolas,monospace;line-height:1.5;word-break:break-all;user-select:text;max-height:84px;overflow:auto";
    codeBox.textContent = "正在读取配对码…";
    const copyRow = document.createElement("div");
    copyRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:8px";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制配对码";
    copy.disabled = true;
    copy.style.cssText = "padding:7px 10px;border:0;border-radius:5px;background:#7c9cff;color:#10131c;font:inherit;font-weight:600;cursor:pointer;opacity:0.55";
    copy.addEventListener("mouseenter", () => { if (!copy.disabled) copy.style.background = "#91adff"; });
    copy.addEventListener("mouseleave", () => (copy.style.background = "#7c9cff"));
    const copyStatus = document.createElement("span");
    copyStatus.setAttribute("role", "status");
    copyStatus.style.cssText = "font-size:12px;color:#8fc99a";
    copyRow.append(copy, copyStatus);
    const pairHint = document.createElement("p");
    pairHint.textContent = "打开 Bowerbird → 探索 → 浏览器插件，粘贴配对码并确认。仅这份插件可采集。";
    pairHint.style.cssText = "margin:8px 0 0;color:#a9a9a9;font-size:12px;line-height:1.5";
    card.append(pairLabel, codeBox, copyRow, pairHint);

    let pairingCode = "";
    const pairingFailed = () => {
      if (!card.isConnected) return;
      codeBox.textContent = "配对码读取失败，请打开扩展选项重试。";
      copy.disabled = true;
      copy.style.opacity = "0.55";
    };
    onUserAction(copy, "click", async () => {
      if (!pairingCode) return;
      const ok = await copyText(pairingCode);
      copyStatus.textContent = ok ? "已复制配对码" : "复制失败，请手动选择配对码";
      copyStatus.style.color = ok ? "#8fc99a" : "#e08a8a";
    });

    const divider = document.createElement("div");
    divider.style.cssText = "height:1px;background:#3d3d3d;margin:14px 0";
    card.append(divider);

    const entryLabel = document.createElement("div");
    entryLabel.textContent = "悬浮按钮";
    entryLabel.style.cssText = "font-size:12px;color:#8faab8;margin-bottom:6px";
    const entryHint = document.createElement("p");
    entryHint.textContent = "拖动可调整位置；拖到左右边缘会自动吸附收起，悬停展开。";
    entryHint.style.cssText = "margin:0 0 8px;color:#a9a9a9;font-size:12px;line-height:1.5";
    const resetRow = document.createElement("div");
    resetRow.style.cssText = "display:flex;align-items:center;gap:8px";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "恢复默认位置";
    reset.style.cssText = "padding:7px 10px;border:1px solid #747474;border-radius:5px;background:#2b2b2b;color:#dcdcdc;font:inherit;cursor:pointer";
    reset.addEventListener("mouseenter", () => (reset.style.background = "#343434"));
    reset.addEventListener("mouseleave", () => (reset.style.background = "#2b2b2b"));
    const resetStatus = document.createElement("span");
    resetStatus.setAttribute("role", "status");
    resetStatus.style.cssText = "font-size:12px;color:#8faab8";
    onUserAction(reset, "click", () => {
      resetButtonPosition();
      resetStatus.textContent = "已恢复默认位置";
    });
    resetRow.append(reset, resetStatus);
    card.append(entryLabel, entryHint, resetRow);

    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;justify-content:space-between;margin-top:14px;padding-top:10px;border-top:1px solid #3d3d3d;color:#8c8c8c;font-size:11px";
    const brand = document.createElement("span");
    brand.textContent = "Bowerbird Collect";
    const version = document.createElement("span");
    version.textContent = `v${chrome.runtime.getManifest?.().version || "—"}`;
    footer.append(brand, version);
    card.append(footer);

    card.addEventListener("mousedown", (event) => event.stopPropagation());
    document.documentElement.appendChild(card);
    placePanel(card, PANEL_WIDTHS[SETTINGS_ID]);
    card.focus?.();

    try {
      chrome.runtime.sendMessage({ type: "pairing_code_get" }, (response) => {
        if (chrome.runtime.lastError || !response?.ok || !response.code) {
          pairingFailed();
          return;
        }
        if (!card.isConnected) return;
        pairingCode = response.code;
        codeBox.textContent = pairingCode;
        copy.disabled = false;
        copy.style.opacity = "1";
      });
    } catch { pairingFailed(); }
  }

  function closeSettings(options = {}) {
    document.getElementById(SETTINGS_ID)?.remove();
    if (options.focus) btn.focus?.();
    scheduleCollapse();
  }
  async function startImageScan() {
    if (collecting || scanning) return;
    scanning = true;
    btn.disabled = true;
    try {
      const batch = S.limitBatch(await collectMaterials());
      if (batch.items.length === 0) {
        showToast("未发现可采集素材", false);
        return;
      }
      showConfirm(batch);
    } catch (error) {
      showToast(S.failureMessage({ error: String(error) }), false, 12000);
    } finally {
      scanning = false;
      btn.disabled = collecting;
      scheduleCollapse();
    }
  }
  async function startVideoScan() {
    if (collecting || scanning) return;
    scanning = true;
    btn.disabled = true;
    try {
      showVideos(await collectVideos());
    } catch {
      showToast("未能读取页面视频，请刷新网页后再试。", false, 10000);
    } finally {
      scanning = false;
      btn.disabled = collecting;
      scheduleCollapse();
    }
  }

  onUserAction(btn, "click", () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (collecting || scanning) return;
    toggleMenu();
  });
  btn.addEventListener("mouseenter", () => {
    hovering = true;
    clearHideTimer();
    setCollapsed(false);
    renderButton();
  });
  btn.addEventListener("mouseleave", () => {
    hovering = false;
    renderButton();
    scheduleCollapse();
  });
  btn.addEventListener("focus", () => {
    clearHideTimer();
    setCollapsed(false);
    renderButton();
  });
  btn.addEventListener("blur", () => {
    renderButton();
    scheduleCollapse();
  });
  btn.addEventListener("dragenter", () => {
    clearHideTimer();
    setCollapsed(false);
  });
  btn.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    btnScale = 1.15;
    renderButton();
    btn.style.boxShadow = "0 0 0 3px #5fd35f,0 2px 12px rgba(0,0,0,0.35)";
  });
  btn.addEventListener("dragleave", resetBtnStyle);
  onUserAction(btn, "drop", async (e) => {
    e.preventDefault();
    resetBtnStyle();
    if (collecting || scanning || handledDrops.has(e.dataTransfer)) return;
    handledDrops.add(e.dataTransfer);
    const video = videoFromDrop(e);
    if (video) { void saveVideo(video); return; }
    const candidates = candidatesFromDropEvent(e);
    if (candidates.length === 0) {
      showToast("未识别到可采集的图片或视频", false);
      return;
    }
    saveBatch(makeGenericBatch(candidates));
  });

  onUserAction(btn, "pointerdown", (e) => {
    if (e.button !== 0 || e.isPrimary === false) return;
    pointerDrag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: buttonState.x,
      originY: buttonState.y,
      originDock: buttonState.dock,
      moved: false,
    };
    clearHideTimer();
    setCollapsed(false);
    try { btn.setPointerCapture?.(e.pointerId); } catch { /* 指针捕获失败时仍可按位置拖动 */ }
  }, true);
  onUserAction(btn, "pointermove", (e) => {
    if (!pointerDrag || (e.pointerId !== undefined && e.pointerId !== pointerDrag.pointerId)) return;
    const dx = e.clientX - pointerDrag.startX;
    const dy = e.clientY - pointerDrag.startY;
    if (!pointerDrag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!pointerDrag.moved) {
      pointerDrag.moved = true;
      dragging = true;
      btnScale = 1.05;
      closeMenu();
    }
    e.preventDefault?.();
    const { width, height } = viewportSize();
    buttonState = {
      x: clamp(pointerDrag.originX + dx, 0, width - BTN_SIZE),
      y: clamp(pointerDrag.originY + dy, 0, height - BTN_SIZE),
      dock: null,
    };
    renderButton();
  });
  function finishPointerDrag(e) {
    if (!pointerDrag || (e?.pointerId !== undefined && e.pointerId !== pointerDrag.pointerId)) return;
    const moved = pointerDrag.moved;
    const pointerId = pointerDrag.pointerId;
    pointerDrag = null;
    dragging = false;
    btnScale = 1;
    if (moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      buttonState.dock = dockFor(buttonState.x);
      if (buttonState.dock) {
        const { width } = viewportSize();
        buttonState.x = buttonState.dock === "left" ? 0 : width - BTN_SIZE;
      }
      const { height } = viewportSize();
      buttonState.y = clamp(buttonState.y, 0, height - BTN_SIZE);
      saveButtonState();
    }
    try { btn.releasePointerCapture?.(pointerId); } catch { /* 已自动释放 */ }
    renderButton();
    if (moved) {
      // A pointer drag focuses the button; release it so edge docking can collapse.
      btn.blur?.();
      scheduleCollapse();
    }
  }
  function cancelPointerDrag() {
    if (!pointerDrag) return;
    buttonState = { x: pointerDrag.originX, y: pointerDrag.originY, dock: pointerDrag.originDock };
    pointerDrag = null;
    dragging = false;
    btnScale = 1;
    renderButton();
    scheduleCollapse();
  }
  onUserAction(btn, "pointerup", finishPointerDrag);
  onUserAction(btn, "pointercancel", cancelPointerDrag);
  btn.addEventListener("lostpointercapture", () => { if (pointerDrag) cancelPointerDrag(); });

  onUserAction(document, "pointerdown", (e) => {
    const panel = document.getElementById(MENU_ID) || document.getElementById(SETTINGS_ID);
    if (!panel) return;
    const path = e.composedPath?.() || [e.target];
    if (path.includes(btn) || path.includes(panel)) return;
    closeMenu();
    closeSettings();
  }, true);
  onUserAction(document, "keydown", (e) => {
    if (e.key !== "Escape") return;
    if (document.getElementById(MENU_ID)) {
      e.preventDefault();
      closeMenu({ focus: true });
      return;
    }
    const picker = document.getElementById("__bowerbird_videos");
    if (picker) {
      e.preventDefault();
      picker.remove();
      btn.focus?.();
      scheduleCollapse();
      return;
    }
    if (document.getElementById(SETTINGS_ID)) {
      e.preventDefault();
      closeSettings({ focus: true });
    }
  }, true);

  window.addEventListener?.("resize", () => {
    const { width, height } = viewportSize();
    buttonState.y = clamp(buttonState.y, 0, height - BTN_SIZE);
    buttonState.x = buttonState.dock === "left"
      ? 0
      : buttonState.dock === "right"
        ? width - BTN_SIZE
        : clamp(buttonState.x, 0, width - BTN_SIZE);
    renderButton();
    for (const [id, maxWidth] of Object.entries(PANEL_WIDTHS)) {
      const panel = document.getElementById(id);
      if (panel) placePanel(panel, maxWidth);
    }
  });

  document.documentElement.appendChild(btn);
  renderButton();
  loadButtonState();
  scheduleCollapse();

  function restoreVideoDraggable() {
    if(!temporaryDraggable)return;
    const {video,attribute}=temporaryDraggable;
    if(video.getAttribute("draggable")==="true") {
      if(attribute===null)video.removeAttribute("draggable");else video.setAttribute("draggable",attribute);
    }
    temporaryDraggable=null;
  }
  onUserAction(document, "pointerdown",e=>{
    restoreVideoDraggable();
    if(e.button!==0 || e.isPrimary===false || e.pointerType==="touch")return;
    const video=(e.composedPath?.() || [e.target]).find(node=>node?.tagName==="VIDEO");
    if(!video || video.draggable)return;
    // Leave the native control strip to seeking/volume/fullscreen; never prevent normal playback clicks.
    const rect=video.getBoundingClientRect();
    if(video.controls && e.clientY>=rect.bottom-Math.min(64,rect.height/2))return;
    temporaryDraggable={video,attribute:video.getAttribute("draggable")};
    video.draggable=true;
  },true);
  document.addEventListener("pointerup",restoreVideoDraggable,true);
  document.addEventListener("pointercancel",restoreVideoDraggable,true);
  window.addEventListener?.("blur",restoreVideoDraggable);
  onUserAction(document, "dragstart",e=>{
    const video=(e.composedPath?.() || [e.target]).find(node=>node?.tagName==="VIDEO");
    draggedVideo=video ? V.element(video,location.href) : null;
  },true);
  document.addEventListener("dragend",()=>{draggedVideo=null;restoreVideoDraggable();},true);

  function videoFromDrop(event) {
    if(draggedVideo) return draggedVideo;
    const html=event.dataTransfer.getData("text/html");
    // Preserve image drops even when a surrounding page/link happens to contain video markup or a video URL.
    if(/<(?:img|picture)\b/i.test(html))return null;
    if(/<video\b/i.test(html)) {
      const doc=new DOMParser().parseFromString(html,"text/html");
      const element=doc.querySelector("video");
      if(element) return V.element(element,location.href);
    }
    const raw=event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    const url=raw.split(/\r?\n/).find(line=>line && !line.startsWith("#"));
    return /\.(mp4|mov|m4v|webm|mkv|avi|m3u8|mpd)(?:$|[?#])/i.test(url || "") ? V.candidate(url,location.href,{source:"video-drop"}) : null;
  }

  async function collectVideos() {
    const items=[];
    for(const root of collectRoots()) root.querySelectorAll?.("video").forEach(video=>items.push(V.element(video,location.href)));
    for(const meta of document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"]')) {
      items.push(V.candidate(meta.getAttribute("content"),location.href,{source:"video-metadata",name:document.title || "页面视频"}));
    }
    let totalJson=0;
    for(const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      const text=script.textContent || ""; totalJson+=text.length;if(totalJson>1024*1024)break;
      try {
        const visit=(value,depth=0)=>{
          if(!value || depth>8)return;
          if(Array.isArray(value)) {value.slice(0,100).forEach(item=>visit(item,depth+1));return;}
          if(typeof value!=="object")return;
          if([value["@type"]].flat().includes("VideoObject")) items.push(V.candidate(value.contentUrl,location.href,{source:"video-jsonld",name:value.name || "页面视频"}));
          for(const key of ["@graph","mainEntity","itemListElement","video"])visit(value[key],depth+1);
        };
        visit(JSON.parse(text));
      }catch{}
    }
    if(location.hostname===XHS_HOST) {
      const detailId=location.pathname.match(/^\/explore\/([^/]+)/)?.[1];
      let state=readXhsInitialState();
      if(detailId && !state?.note?.noteDetailMap?.[detailId]) state=(await fetchXhsDetailState()) || state;
      const detail=state?.note?.noteDetailMap?.[detailId];
      const note=detail?.note || detail;
      const xhs=V.xhs(note,canonicalXhsNoteUrl(detailId));
      if(xhs) items.unshift(xhs);
    }
    return dedupeBy(items.filter(Boolean),item=>item.media_url).slice(0,50);
  }

  function showVideos(items) {
    closeSettings();
    hideConfirm();document.getElementById("__bowerbird_videos")?.remove();
    document.getElementById("__bowerbird_toast")?.remove();
    if(!items.length) {showToast("未发现可采集视频，请先打开视频详情或开始播放后再试。",false,10000);return;}
    const card=document.createElement("section");card.id="__bowerbird_videos";
    card.setAttribute("role","dialog");card.setAttribute("aria-label","选择视频");
    card.style.cssText="position:fixed;padding:16px;background:#1e1e1e;color:#dcdcdc;border:1px solid #747474;border-radius:6px;font:13px -apple-system,sans-serif;box-shadow:0 4px 16px #0006;z-index:2147483647";
    const heading=document.createElement("div");heading.style.cssText="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px";
    const title=document.createElement("strong");title.textContent="选择视频";
    const closeCard=()=>{card.remove();btn.focus?.();scheduleCollapse();};
    const close=document.createElement("button");close.textContent="关闭";close.style.cssText="background:none;border:0;color:inherit;cursor:pointer;padding:6px";close.onclick=closeCard;
    heading.append(title,close);card.append(heading);
    items.forEach((item,index)=>{
      const row=document.createElement("div");row.style.cssText="display:flex;gap:12px;align-items:center;border-top:1px solid #3d3d3d;padding:12px 0";
      const name=document.createElement("span");name.textContent=item.name==="视频" || item.name==="页面视频" ? `视频 ${index+1}` : item.name;name.style.cssText="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      const action=document.createElement("button");action.textContent="采集视频";action.style.cssText="flex-shrink:0;padding:8px;background:none;color:#8faab8;border:1px solid #747474;border-radius:4px;cursor:pointer";
      onUserAction(action, "click", ()=>{card.remove();void saveVideo(item);});row.append(name,action);card.append(row);
    });
    card.addEventListener("keydown",event=>{if(event.key==="Escape") {event.preventDefault();closeCard();}});
    card.addEventListener("mousedown",event=>event.stopPropagation());
    document.documentElement.appendChild(card);placePanel(card,PANEL_WIDTHS.__bowerbird_videos);close.focus?.();
  }

  async function savePageVideo(item) {
    const support=await S.checkVideoSupport();if(!support.ok)return support;
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),S.VIDEO_FETCH_TIMEOUT_MS);
    try {
      const response=await fetch(item.media_url,{signal:controller.signal});
      if(!response.ok)return {ok:false,code:"unsupported_stream"};
      const bytes=await V.read(response,support.maxBytes);if(V.stream(bytes))return {ok:false,code:"unsupported_stream"};const ext=V.format(bytes);
      if(!ext)return {ok:false,code:"invalid_video"};
      clearTimeout(timer);
      return S.uploadBytes(bytes.buffer,{media_kind:"video",requested_url:location.href,effective_url:location.href,page_url:item.source_url,
        url:location.href,file_name:`video.${ext}`,content_type:response.headers.get("content-type") || "",candidate_source:"page-video"});
    }catch(error){return {ok:false,code:error?.code || (error?.name==="AbortError" ? "fetch_timeout" : "unsupported_stream")};}
    finally {clearTimeout(timer);}
  }

  async function saveVideo(item) {
    if(collecting || scanning)return;
    if(item.blocked){showToast(S.failureMessage({code:item.blocked},"video"),false,12000);return;}
    collecting=true;btn.disabled=true;btn.setAttribute("aria-busy","true");hideConfirm();closeMenu();closeSettings();
    document.getElementById("__bowerbird_videos")?.remove();
    showToast("正在采集视频，请保持网页打开…",true,0);
    try {
      const result=/^(blob:|data:)/i.test(item.media_url) ? await savePageVideo(item) : await S.requestBackground(item);
      showToast(result.ok ? "视频已保存到素材库" : S.failureMessage(result,"video"),result.ok || result.saved,12000);
    }catch {showToast("视频未能采集，请刷新网页后再试。",false,12000);}
    finally {collecting=false;btn.disabled=false;btn.setAttribute("aria-busy","false");scheduleCollapse();}
  }

  function resetBtnStyle() {
    btnScale = 1;
    renderButton();
    btn.style.boxShadow = "0 2px 12px rgba(0,0,0,0.35)";
  }

  function showToast(text, ok = true, duration = 3000) {
    document.getElementById("__bowerbird_toast")?.remove();
    const t = document.createElement("div");
    t.id = "__bowerbird_toast";
    t.textContent = text;
    t.style.cssText = [
      "position:fixed",
      "padding:8px 12px",
      "border-radius:6px",
      "font:13px -apple-system,sans-serif",
      "color:#fff",
      ok ? "background:#2e7d32" : "background:#c62828",
      "z-index:2147483647",
      "box-shadow:0 2px 8px rgba(0,0,0,0.3)",
    ].join(";");
    t.setAttribute("role", "status");
    document.documentElement.appendChild(t);
    placePanel(t, PANEL_WIDTHS.__bowerbird_toast);
    if (duration > 0) setTimeout(() => t.remove(), duration);
  }

  async function collectMaterials() {
    if (location.hostname === XHS_HOST) {
      const xhsBatch = await collectXiaohongshu();
      if (xhsBatch && xhsBatch.items.length > 0) return xhsBatch;
      const domBatch = collectXhsDomMaterials();
      if (domBatch.items.length > 0) return domBatch;
    }
    return makeGenericBatch(collectGenericCandidates());
  }

  async function collectXiaohongshu() {
    const detailId = location.pathname.match(/^\/explore\/([^/]+)/)?.[1];
    let state = readXhsInitialState();
    // 站内 SPA 打开详情时，首屏 script 仍可能是发现页状态；按当前可见 URL 重取公开 HTML。
    if (detailId && !state?.note?.noteDetailMap?.[detailId]) {
      state = (await fetchXhsDetailState()) || state;
    }
    if (!state) return null;

    if (detailId) {
      const detail = state.note?.noteDetailMap?.[detailId];
      const note = detail?.note;
      if (!note || note.type === "video") return null;
      const images = dedupeBy(
        (note.imageList || [])
          .map((image, index, all) => ({
            media_url: normalizeMediaUrl(
              image.urlDefault ||
                image.urlPre ||
                image.infoList?.find((item) => item.imageScene === "WB_DFT")?.url
            ),
            source_url: canonicalXhsNoteUrl(detailId),
            source_id: detailId,
            title: note.title || "小红书图片",
            author: note.user?.nickname || "",
            index,
            total: all.length,
            media_kind: "image",
          }))
          .filter((item) => item.media_url),
        (item) => item.media_url
      );
      return {
        source_site: "xiaohongshu",
        label: `本笔记共 ${images.length} 张图片，全部采集？`,
        items: images,
      };
    }

    const feeds = state.feed?.feeds;
    if (!Array.isArray(feeds)) return null;
    const structuredCovers =
      feeds
        .filter((feed) => feed?.modelType === "note" && !feed.ignore)
        .map((feed) => {
          const card = feed.noteCard || {};
          return {
            media_url: normalizeMediaUrl(card.cover?.urlDefault || card.cover?.urlPre),
            source_url: canonicalXhsNoteUrl(feed.id),
            source_id: feed.id || "",
            title: card.displayTitle || "小红书封面",
            author: card.user?.nickname || "",
            media_kind: "cover",
            note_type: card.type || "normal",
          };
        })
        .filter((item) => item.media_url && item.source_id);
    const covers = dedupeBy(
      structuredCovers.concat(collectXhsDomCovers()),
      (item) => item.source_id
    );
    covers.forEach((item, index) => {
      item.index = index;
      item.total = covers.length;
    });
    return {
      source_site: "xiaohongshu",
      label: `发现 ${covers.length} 条笔记封面，全部采集？`,
      items: covers,
    };
  }

  function collectXhsDomMaterials() {
    const detailId = location.pathname.match(/^\/explore\/([^/]+)/)?.[1];
    if (detailId) {
      const images = dedupeBy(
        Array.from(document.querySelectorAll(".note-slider-img img"))
          .map((image) => normalizeMediaUrl(image.currentSrc || image.src))
          .filter(Boolean),
        (url) => url
      );
      return {
        source_site: "xiaohongshu",
        label: `当前页面发现 ${images.length} 张图片，全部采集？`,
        items: images.map((url, index) => ({
          media_url: url,
          source_url: canonicalXhsNoteUrl(detailId),
          source_id: detailId,
          index,
          total: images.length,
          media_kind: "image",
        })),
      };
    }
    const covers = collectXhsDomCovers();
    covers.forEach((item, index) => {
      item.index = index;
      item.total = covers.length;
    });
    return {
      source_site: "xiaohongshu",
      label: `发现 ${covers.length} 条笔记封面，全部采集？`,
      items: covers,
    };
  }

  function collectXhsDomCovers() {
    return dedupeBy(
      Array.from(document.querySelectorAll('a[href*="/explore/"] img'))
        .map((image) => {
          const link = image.closest('a[href*="/explore/"]');
          const noteId = link?.pathname.match(/^\/explore\/([^/]+)/)?.[1];
          return {
            media_url: normalizeMediaUrl(image.currentSrc || image.src),
            source_url: canonicalXhsNoteUrl(noteId),
            source_id: noteId || "",
            title: "小红书封面",
            media_kind: "cover",
          };
        })
        .filter((item) => item.media_url && item.source_id),
      (item) => item.source_id
    );
  }

  function readXhsInitialState(root = document) {
    const prefix = "window.__INITIAL_STATE__=";
    const script = Array.from(root.scripts || []).find((node) =>
      (node.textContent || "").startsWith(prefix)
    );
    if (!script) return null;
    try {
      const json = replaceUndefinedValues(script.textContent.slice(prefix.length));
      return JSON.parse(json);
    } catch (err) {
      console.warn("Bowerbird: 小红书页面数据解析失败，回退 DOM 扫描", err);
      return null;
    }
  }

  async function fetchXhsDetailState() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), S.FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(location.href, {
        credentials: "omit",
        headers: { Accept: "text/html" },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      return readXhsInitialState(doc);
    } catch (err) {
      console.warn("Bowerbird: 小红书详情 HTML 读取失败，回退当前 DOM", err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // 小红书的内嵌对象接近 JSON，但部分值是 undefined；只在字符串外替换，绝不执行页面文本。
  function replaceUndefinedValues(text) {
    let output = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        output += ch;
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        output += ch;
      } else if (text.startsWith("undefined", i)) {
        output += "null";
        i += "undefined".length - 1;
      } else {
        output += ch;
      }
    }
    return output;
  }

  function canonicalXhsNoteUrl(noteId) {
    return noteId ? `https://${XHS_HOST}/explore/${noteId}` : location.href;
  }

  function normalizeMediaUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value, location.href);
      if (url.protocol === "http:" && /(^|\.)xhscdn\.com$/.test(url.hostname)) {
        url.protocol = "https:";
      }
      return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  function dedupeBy(items, keyOf) {
    const seen = new Set();
    return items.filter((item) => {
      const key = keyOf(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const C = globalThis.BowerbirdCandidates;
  const LAZY_URL_ATTRS = [
    "data-src", "data-original", "data-lazy-src", "data-url", "data-image", "data-original-src",
  ];
  const LAZY_SRCSET_ATTRS = ["data-srcset", "data-lazy-srcset"];

  function elementVisible(el) {
    const rect = el.getBoundingClientRect?.();
    if (!rect) return true;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
  }

  function addElementImageCandidates(out, image, pageUrl, priority = 80) {
    const visible = elementVisible(image);
    const options = {
      pageUrl,
      width: image.naturalWidth || image.clientWidth || 0,
      height: image.naturalHeight || image.clientHeight || 0,
      visible,
    };
    // 同一 <img> 元素在 currentSrc / srcset / picture / lazy data-* 里通常指向**同一张图
    // 的不同分辨率版本**（如 Pinterest 236w 网格缩略图与完整图）。若全部发出，扩展会把它
    // 当作多张采集 → 瀑布流出现两张一样素材（即使后端已做 dHash 阈值去重，也尽量在源头
    // 收敛）。故每个元素只取一张候选：按来源可信度取最高清版本（见 pickBestVariant）。
    const candidates = [];
    const current = C.candidate(image.currentSrc || image.getAttribute("src"), document.baseURI, {
      ...options, source: "currentSrc", priority: priority + 20,
    });
    if (current) candidates.push(current);

    const ownSrcset = C.parseSrcset(image.getAttribute("srcset"), document.baseURI);
    if (ownSrcset) candidates.push(C.candidate(ownSrcset.url, document.baseURI, {
      ...options, source: "srcset", priority: priority + 15,
    }));
    image.closest("picture")?.querySelectorAll("source[srcset]").forEach((source) => {
      const selected = C.parseSrcset(source.getAttribute("srcset"), document.baseURI);
      if (selected) candidates.push(C.candidate(selected.url, document.baseURI, {
        ...options, source: "picture", priority: priority + 15,
      }));
    });
    for (const attr of LAZY_URL_ATTRS) {
      const value = image.getAttribute(attr);
      if (value) candidates.push(C.candidate(value, document.baseURI, {
        ...options, source: "lazy", priority: priority + 10,
      }));
    }
    for (const attr of LAZY_SRCSET_ATTRS) {
      const selected = C.parseSrcset(image.getAttribute(attr), document.baseURI);
      if (selected) candidates.push(C.candidate(selected.url, document.baseURI, {
        ...options, source: "lazy-srcset", priority: priority + 10,
      }));
    }
    const best = pickBestVariant(candidates);
    if (best) out.push(best);
  }

  // 从同一元素的多分辨率候选中挑「最高分辨率」的一张。
  // 同一 <img> 的 currentSrc / srcset / lazy data-* 通常指向同一张图的不同分辨率版本；
  // 且 `naturalWidth/clientWidth` 是该元素**当前显示**的尺寸、对所有候选相同，无法据此区分
  // 各 URL 的真实分辨率。故按来源可信度分级：
  //   0 srcset/picture/lazy-srcset —— 显式的分辨率集合，选中的最高描述符就是最高清版本
  //   1 lazy data-*（data-src 等）—— 懒加载的真实大图（占位符只是 currentSrc）
  //   2 currentSrc —— 当前显示的（可能是缩略图/占位符）
  // 同层内优先宽高更大的（srcset 已按最高描述符选中，通常同 URL）。
  function pickBestVariant(candidates) {
    const tier = (source) =>
      source === "srcset" || source === "picture" || source === "lazy-srcset"
        ? 0
        : source === "lazy"
          ? 1
          : 2;
    return candidates
      .filter(Boolean)
      .map((item) => ({ item, key: tier(item.source), area: (item.width || 0) * (item.height || 0) }))
      .sort((a, b) => a.key - b.key || b.area - a.area)[0]?.item || null;
  }

  function cssBackgroundCandidates(el, pageUrl, priority = 55) {
    if (!elementVisible(el)) return [];
    const rect = el.getBoundingClientRect?.();
    if (rect && rect.width * rect.height < 4096) return [];
    const background = getComputedStyle(el).backgroundImage || "";
    const found = [];
    const re = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    let match;
    while ((match = re.exec(background))) {
      found.push(C.candidate(match[1], document.baseURI, {
        source: "css", priority, pageUrl,
        width: rect?.width || 0, height: rect?.height || 0, visible: true,
      }));
    }
    return found.filter(Boolean);
  }

  function collectRoots() {
    const roots = [document];
    let seenNodes = 0;
    for (let i = 0; i < roots.length && seenNodes < 5000; i += 1) {
      const nodes = roots[i].querySelectorAll?.("*") || [];
      for (const node of nodes) {
        seenNodes += 1;
        if (node.shadowRoot) roots.push(node.shadowRoot);
        if (seenNodes >= 5000) break;
      }
    }
    return roots;
  }

  function collectMetadataCandidates(out, pageUrl) {
    const selectors = [
      'meta[property="og:image:secure_url"]', 'meta[property="og:image"]',
      'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]', 'link[rel="image_src"]',
    ];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((el) => {
        const value = el.getAttribute("content") || el.getAttribute("href");
        out.push(C.candidate(value, document.baseURI, { source: "metadata", priority: 70, pageUrl }));
      });
    }

    let totalJson = 0;
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      const text = script.textContent || "";
      totalJson += text.length;
      if (totalJson > 1024 * 1024 || text.length > 512 * 1024) return;
      try {
        const visit = (value, depth = 0) => {
          if (depth > 8 || value == null) return;
          if (typeof value === "string") return;
          if (Array.isArray(value)) return value.forEach((v) => visit(v, depth + 1));
          if (typeof value !== "object") return;
          for (const key of ["image", "contentUrl", "thumbnailUrl"]) {
            if(key==="contentUrl" && [value["@type"]].flat().includes("VideoObject"))continue;
            const image = value[key];
            const add = (v) => {
              const url = typeof v === "string" ? v : v?.url || v?.contentUrl;
              out.push(C.candidate(url, document.baseURI, { source: "jsonld", priority: 65, pageUrl }));
            };
            if (Array.isArray(image)) image.forEach(add);
            else if (image) add(image);
          }
          for (const [key, child] of Object.entries(value)) {
            if (["image", "contentUrl", "thumbnailUrl"].includes(key)) continue;
            if (key === "@graph" || key === "itemListElement" || key === "mainEntity") visit(child, depth + 1);
          }
        };
        visit(JSON.parse(text));
      } catch { /* malformed JSON-LD is common; skip */ }
    });
  }

  function collectGenericCandidates() {
    const pageUrl = location.href;
    const out = [];
    const roots = collectRoots();
    for (const root of roots) {
      root.querySelectorAll?.("img").forEach((img) => addElementImageCandidates(out, img, pageUrl));
      root.querySelectorAll?.("video[poster]").forEach((video) => {
        out.push(C.candidate(video.poster || video.getAttribute("poster"), document.baseURI, {
          source: "poster", priority: 60, pageUrl,
          width: video.videoWidth || video.clientWidth, height: video.videoHeight || video.clientHeight,
          visible: elementVisible(video),
        }));
      });
      root.querySelectorAll?.('svg image[href], svg image[xlink\\:href]').forEach((image) => {
        out.push(C.candidate(image.getAttribute("href") || image.getAttribute("xlink:href"), document.baseURI, {
          source: "svg-image", priority: 60, pageUrl, visible: elementVisible(image),
        }));
      });
      const cssSelector = '[style*="background"], [role="img"], [class*="image" i], [class*="photo" i], [class*="hero" i], [class*="cover" i], [class*="gallery" i], [class*="product" i]';
      Array.from(root.querySelectorAll?.(cssSelector) || []).slice(0, 1000).forEach((el) => {
        out.push(...cssBackgroundCandidates(el, pageUrl));
      });
    }
    document.querySelectorAll('link[rel="preload"][as="image"]').forEach((link) => {
      out.push(C.candidate(link.href, document.baseURI, { source: "preload", priority: 55, pageUrl }));
    });
    collectMetadataCandidates(out, pageUrl);
    return C.rankAndDedupe(out);
  }

  function makeGenericBatch(values, sourceUrl = location.href) {
    const candidates = values.map((value) => {
      if (typeof value === "string") {
        return C.candidate(value, document.baseURI, {
          source: "legacy", priority: 50, pageUrl: sourceUrl,
        });
      }
      return value;
    });
    const unique = C.rankAndDedupe(candidates);
    return {
      source_site: "web",
      label: `发现 ${unique.length} 张图片，全部采集？`,
      items: unique.map((item, index) => ({
        media_url: item.url,
        source_url: item.pageUrl || sourceUrl,
        candidate_kind: item.kind,
        candidate_source: item.source,
        index,
        total: unique.length,
        media_kind: "image",
      })),
    };
  }

  function candidatesFromDropEvent(e) {
    const dt = e.dataTransfer;
    return C.dropCandidatesFromValues({
      html: dt.getData("text/html") || "",
      uriList: dt.getData("text/uri-list") || "",
      plain: dt.getData("text/plain") || "",
      base: location.href,
    });
  }

  function showConfirm(batch) {
    closeSettings();
    hideConfirm();
    const card = document.createElement("div");
    card.id = "__bowerbird_confirm";
    card.style.cssText = [
      "position:fixed",
      "padding:12px 14px",
      "border-radius:10px",
      "background:#1f2330",
      "color:#fff",
      "font:13px -apple-system,sans-serif",
      "box-shadow:0 4px 16px rgba(0,0,0,0.4)",
      "z-index:2147483647",
    ].join(";");
    const label = document.createElement("div");
    label.textContent = batch.label;
    label.style.marginBottom = "10px";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
    const baseBtnStyle =
      "border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font:13px -apple-system,sans-serif";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    cancel.style.cssText = baseBtnStyle + ";background:#3a3f4f;color:#fff";
    const ok = document.createElement("button");
    ok.textContent = "采集";
    ok.style.cssText = baseBtnStyle + ";background:#7c9cff;color:#000;font-weight:600";
    actions.append(cancel, ok);
    card.append(label, actions);
    document.documentElement.appendChild(card);
    placePanel(card, PANEL_WIDTHS.__bowerbird_confirm);

    const close = () => {
      card.remove();
      scheduleCollapse();
    };
    const timer = setTimeout(close, 15000);
    cancel.onclick = () => {
      clearTimeout(timer);
      close();
    };
    onUserAction(ok, "click", () => {
      clearTimeout(timer);
      close();
      saveBatch(batch);
    });
    card.addEventListener("mousedown", (e) => e.stopPropagation());
  }

  function hideConfirm() {
    document.getElementById("__bowerbird_confirm")?.remove();
  }

  async function uploadLocalBytes(bytes, metadata) {
    if (!bytes || bytes.byteLength === 0) return { ok: false, code: "invalid_image", error: "页面图片字节为空" };
    if (bytes.byteLength > S.MAX_INLINE_BYTES) {
      return { ok: false, code: "too_large", error: "页面内嵌图片超过 20 MiB 上限" };
    }
    return S.uploadBytes(bytes, metadata);
  }

  async function saveLocalCandidate(candidate, pageUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), S.FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(candidate.url, { signal: controller.signal });
      if (!response.ok) return { ok: false, error: `页面读取图片失败：HTTP ${response.status}` };
      if (Number(response.headers.get("content-length")) > S.MAX_INLINE_BYTES) return { ok: false, code: "too_large" };
      const contentType = response.headers.get("content-type") || "";
      const bytes = await response.arrayBuffer();
      return uploadLocalBytes(bytes, {
        requested_url: pageUrl,
        effective_url: pageUrl,
        page_url: pageUrl,
        url: pageUrl,
        file_name: "page-image",
        content_type: contentType,
        candidate_source: candidate.source,
      });
    } catch (error) {
      return { ok: false, code: error?.name === "AbortError" ? "fetch_timeout" : "fetch_failed", error: String(error) };
    } finally {
      clearTimeout(timer);
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

  // Instagram 等站点会在图片上覆盖透明层，并把 IMG 设为 pointer-events:none；
  // 点击路径里没有 IMG，但图片仍按几何位置可见。按点击坐标找回最贴合的那张。
  function imageAtPoint(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !document.images) return null;
    let best = null;
    let bestArea = Infinity;
    let bestPixels = -1;
    let bestIndex = -1;
    let index = 0;
    for (const image of Array.from(document.images)) {
      const currentIndex = index++;
      if (!image || image.tagName !== "IMG" || btn.contains?.(image)) continue;
      const rect = image.getBoundingClientRect?.();
      if (!rect || rect.width <= 1 || rect.height <= 1) continue;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      if (!elementVisible(image)) continue;
      if (!(image.currentSrc || image.getAttribute?.("src"))) continue;
      const area = rect.width * rect.height;
      const pixels = (image.naturalWidth || 0) * (image.naturalHeight || 0);
      if (
        area < bestArea ||
        (area === bestArea && (pixels > bestPixels || (pixels === bestPixels && currentIndex > bestIndex)))
      ) {
        best = image;
        bestArea = area;
        bestPixels = pixels;
        bestIndex = currentIndex;
      }
    }
    return best;
  }

  onUserAction(document,
    "click",
    async (e) => {
      if (!e.altKey) return;
      if (collecting || scanning) return;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
      const ownUi = path.some((node) =>
        node === btn ||
        node?.id === MENU_ID ||
        node?.id === "__bowerbird_confirm" ||
        node?.id === "__bowerbird_videos" ||
        node?.id === "__bowerbird_toast"
      );
      if (ownUi) return;
      const video=path.find(node=>node?.tagName==="VIDEO");
      if(video) {
        e.preventDefault();e.stopPropagation();
        const item=V.element(video,location.href);
        if(item)showVideos([item]);else showToast("未读取到视频地址，请先开始播放后再试。",false,10000);
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
    if (collecting || batch.items.length === 0) return;
    collecting = true;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    hideConfirm();
    closeMenu();
    closeSettings();
    document.getElementById("__bowerbird_videos")?.remove();
    try {
      // 普通 URL 由后台继承浏览器会话取图；页面 blob/data 只能在当前页面读取。
      const summary = await S.runBatch(batch.items, {
        remote: (item) => S.requestBackground({ ...item, source_url: item.source_url || location.href }),
        local: (item) => saveLocalCandidate({ url: item.media_url, source: item.candidate_source }, item.source_url || location.href),
        canvas: (item) => saveCanvas(item.canvas, item.source_url || location.href),
      }, (progress) => showToast(S.progressMessage(progress), true, 0));
      showToast(S.progressMessage(summary, true), summary.failed === 0 && summary.unconfirmed === 0, 12000);
    } finally {
      collecting = false;
      btn.disabled = false;
      btn.setAttribute("aria-busy", "false");
      scheduleCollapse();
    }
  }
})();
