(() => {
  "use strict";
  const HOST_ID = "__bowerbird_overlay";
  const MENU_ID = "__bowerbird_menu";
  const SETTINGS_ID = "__bowerbird_settings";
  const PANEL_WIDTHS = {
    [MENU_ID]: 220,
    [SETTINGS_ID]: 360,
    __bowerbird_confirm: 380,
    __bowerbird_videos: 340,
    __bowerbird_toast: 380,
  };

  // Require trusted browser input for actions that can capture or change settings.
  function onUserAction(target, type, handler, capture = false) {
    target.addEventListener(type, event => {
      if (event.isTrusted) return handler(event);
    }, capture);
  }

  function create({ getBusy, onButton, onDrop }) {
    const host = document.createElement("div");
    host.id = HOST_ID;
    for (const [name, value] of Object.entries({
      all: "initial", position: "fixed", inset: "0", "z-index": "2147483647",
      "pointer-events": "none", visibility: "visible", opacity: "1",
    })) host.style.setProperty(name, value, "important");
    const root = host.attachShadow({ mode: "closed" });
    const container = document.createElement("div");
    container.style.cssText = "all:initial;display:contents;direction:ltr";
    const style = document.createElement("style");
    style.textContent = `:focus-visible { outline: 2px solid #91adff; outline-offset: 2px; }
      @media(prefers-reduced-motion: reduce) { button { transition:none !important; } }`;
    root.append(style, container);
    document.documentElement.appendChild(host);

    const BTN_SIZE = 48;
    const BTN_MARGIN = 24;
    const SNAP_DISTANCE = 16;
    const PEEK = 12;
    const HIDE_DELAY_MS = 1200;
    const DRAG_THRESHOLD = 4;
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
    btn.style.pointerEvents = "auto";

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
    let hidden = false;

    function renderButton() {
      const shift = collapsed && buttonState.dock
        ? (buttonState.dock === "left" ? -(BTN_SIZE - PEEK) : BTN_SIZE - PEEK)
        : 0;
      btn.style.display = hidden ? "none" : "flex";
      btn.style.left = `${buttonState.x}px`;
      btn.style.top = `${buttonState.y}px`;
      btn.style.transform = `translateX(${shift}px) scale(${btnScale})`;
      btn.style.cursor = dragging ? "grabbing" : "grab";
      btn.style.opacity = hovering || dragging ? "1" : collapsed ? "0.75" : "0.85";
      btn.setAttribute("aria-expanded", root.getElementById(MENU_ID) ? "true" : "false");
    }

    const panelOpen = () => [MENU_ID, SETTINGS_ID, "__bowerbird_confirm", "__bowerbird_videos"]
      .some(id => root.getElementById(id));
    function canAutoCollapse() {
      if (!buttonState.dock || dragging || hovering || getBusy() || panelOpen()) return false;
      const active = root.activeElement;
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
      panel.style.pointerEvents = "auto";
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
      const { height } = viewportSize();
      buttonState.yRatio = height > BTN_SIZE ? buttonState.y / (height - BTN_SIZE) : 0;
      try {
        chrome.runtime.sendMessage(
          {
            type: "button_position_set",
            position: buttonState,
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
          const span = Math.max(0, height - BTN_SIZE);
          const ratio = Number.isFinite(saved.yRatio) ? clamp(saved.yRatio, 0, 1) : null;
          const y = ratio === null ? Number(saved.y) : ratio * span;
          const x = dock === "left" ? 0 : dock === "right" ? width - BTN_SIZE : Number(saved.x);
          if (!Number.isFinite(y) || !Number.isFinite(x)) return;
          positionCustomized = true;
          buttonState = {
            x: clamp(x, 0, width - BTN_SIZE),
            y: clamp(y, 0, span),
            yRatio: ratio ?? (span ? clamp(y, 0, span) / span : 0),
            dock,
          };
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

    function mount(panel) {
      container.append(panel);
      placePanel(panel, PANEL_WIDTHS[panel.id]);
    }
    function remove(id) {
      root.getElementById(id)?.remove();
      if (id === MENU_ID) btn.setAttribute("aria-expanded", "false");
    }
    function setVisibility(value) {
      hidden = !value;
      renderButton();
    }

    function resetButtonPosition() {
      buttonState = defaultButtonState();
      collapsed = false;
      clearHideTimer();
      renderButton();
      saveButtonState();
    }

    function resetBtnStyle() {
      btnScale = 1;
      renderButton();
      btn.style.boxShadow = "0 2px 12px rgba(0,0,0,0.35)";
    }

    onUserAction(btn, "click", () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (!getBusy()) onButton();
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
    onUserAction(btn, "drop", (e) => {
      e.preventDefault();
      resetBtnStyle();
      if (!getBusy()) onDrop(e);
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
        originYRatio: buttonState.yRatio,
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
        remove(MENU_ID);
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
      buttonState = { x: pointerDrag.originX, y: pointerDrag.originY, yRatio: pointerDrag.originYRatio, dock: pointerDrag.originDock };
      pointerDrag = null;
      dragging = false;
      btnScale = 1;
      renderButton();
      scheduleCollapse();
    }
    onUserAction(btn, "pointerup", finishPointerDrag);
    onUserAction(btn, "pointercancel", cancelPointerDrag);
    btn.addEventListener("lostpointercapture", () => { if (pointerDrag) cancelPointerDrag(); });

    window.addEventListener("resize", () => {
      const { width, height } = viewportSize();
      if (!positionCustomized) {
        buttonState = defaultButtonState();
      } else {
        const span = Math.max(0, height - BTN_SIZE);
        buttonState.y = Number.isFinite(buttonState.yRatio)
          ? clamp(buttonState.yRatio * span, 0, span) : clamp(buttonState.y, 0, span);
        buttonState.x = buttonState.dock === "left"
          ? 0
          : buttonState.dock === "right"
            ? Math.max(0, width - BTN_SIZE)
            : clamp(buttonState.x, 0, width - BTN_SIZE);
      }
      renderButton();
      for (const [id, maxWidth] of Object.entries(PANEL_WIDTHS)) {
        const panel = root.getElementById(id);
        if (panel) placePanel(panel, maxWidth);
      }
    });

    container.append(btn);
    renderButton();
    loadButtonState();
    scheduleCollapse();
    return {
      btn, mount, remove, root,
      ownsEvent: event => event.composedPath().includes(host),
      resetButtonPosition, scheduleCollapse, setVisibility,
    };
  }

  globalThis.BowerbirdOverlay = { create, onUserAction, MENU_ID, SETTINGS_ID };
})();
