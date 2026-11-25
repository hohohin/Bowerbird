(() => {
  "use strict";
  const { onUserAction, MENU_ID, SETTINGS_ID } = globalThis.BowerbirdOverlay;

  function create(overlay, { startImageScan, startVideoScan, saveVideo, hideConfirm, setSiteHidden, isHidden }) {
    const { btn, resetButtonPosition, scheduleCollapse } = overlay;
    let refreshPairingCode;
    window.addEventListener("focus", () => { void refreshPairingCode?.(); });

    function appendCurrentProject(card) {
      const row = document.createElement("div");
      row.style.cssText = "padding:7px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#bbb;font:13px sans-serif";
      row.textContent = "当前项目：读取中…";
      card.append(row);
      const unavailable = () => { row.textContent = "当前项目：暂不可用"; };
      try {
        chrome.runtime.sendMessage({type:"current_project"}, reply => {
          if (chrome.runtime.lastError || !reply?.ok) return unavailable();
          row.textContent = "当前项目：" + (reply.name || "未选择");
          row.title = reply.name ? "采集图将进入该项目的画布中" : "未选择项目时，采集图将进入素材库";
        });
      } catch { unavailable(); }
    }

    function openMenu() {
      closeMenu();
      closeSettings();
      hideConfirm();
      overlay.root.getElementById("__bowerbird_videos")?.remove();
      overlay.root.getElementById("__bowerbird_toast")?.remove();
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
      appendCurrentProject(card);
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
      overlay.mount(card);
      btn.setAttribute("aria-expanded", "true");
      firstItem?.focus?.();
    }
    function closeMenu(options = {}) {
      overlay.root.getElementById(MENU_ID)?.remove();
      btn.setAttribute("aria-expanded", "false");
      if (options.focus) btn.focus?.();
      scheduleCollapse();
    }
    function toggleMenu() {
      if (overlay.root.getElementById(MENU_ID)) {
        closeMenu({ focus: true });
        return;
      }
      if (overlay.root.getElementById(SETTINGS_ID)) {
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
        overlay.root.append(area);
        try {
          area.focus();
          area.select();
          return document.execCommand("copy");
        } finally {
          area.remove();
        }
      } catch { return false; }
    }

    function openSettings() {
      closeMenu();
      closeSettings();
      hideConfirm();
      overlay.root.getElementById("__bowerbird_videos")?.remove();
      overlay.root.getElementById("__bowerbird_toast")?.remove();

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
      appendCurrentProject(card);

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
      const options = document.createElement("button");
      options.type = "button";
      options.textContent = "打开完整选项页";
      options.style.cssText = "padding:7px 10px;border:1px solid #747474;border-radius:5px;background:#2b2b2b;color:#dcdcdc;font:inherit;cursor:pointer;margin-top:8px";
      onUserAction(options, "click", () => {
        try {
          chrome.runtime.sendMessage({ type: "open_pairing_options" }, reply => {
            if (chrome.runtime.lastError || !reply?.ok) copyStatus.textContent = "请从浏览器扩展管理打开选项页";
          });
        } catch { copyStatus.textContent = "请从浏览器扩展管理打开选项页"; }
      });
      card.append(pairLabel, codeBox, copyRow, pairHint, options);

      async function loadPairingCode() {
        let code = "";
        try {
          const reply = await new Promise(resolve => chrome.runtime.sendMessage({ type: "pairing_code_get" }, response => {
            resolve(chrome.runtime.lastError ? null : response);
          }));
          if (reply?.ok) code = reply.code;
        } catch { /* An extension reload invalidates this page's messaging context. */ }
        if (!card.isConnected) return "";
        codeBox.textContent = code || "配对码读取失败，请打开扩展选项重试。";
        copy.disabled = !code;
        copy.style.opacity = code ? "1" : "0.55";
        return code;
      }
      onUserAction(copy, "click", async () => {
        copy.disabled = true;
        const code = await loadPairingCode();
        if (!code) return;
        const ok = await copyText(code);
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
      if (/^https?:$/.test(location.protocol)) {
        const hideLabel = document.createElement("label");
        hideLabel.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer";
        const hide = document.createElement("input");
        hide.type = "checkbox";
        hide.checked = isHidden();
        hideLabel.append(hide, "在当前网站隐藏悬浮按钮");
        onUserAction(hide, "change", () => {
          const hidden = hide.checked;
          void setSiteHidden(hidden).then(ok => {
            if (ok) {
              closeSettings({ focus: !hidden });
            } else {
              hide.checked = !hidden;
              resetStatus.textContent = "无法保存此网站的设置，请稍后重试";
            }
          });
        });
        card.append(hideLabel);
      }

      const footer = document.createElement("div");
      footer.style.cssText = "display:flex;justify-content:space-between;margin-top:14px;padding-top:10px;border-top:1px solid #3d3d3d;color:#8c8c8c;font-size:11px";
      const brand = document.createElement("span");
      brand.textContent = "Bowerbird Collect";
      const version = document.createElement("span");
      version.textContent = `v${chrome.runtime.getManifest?.().version || "—"}`;
      footer.append(brand, version);
      card.append(footer);

      card.addEventListener("mousedown", (event) => event.stopPropagation());
      overlay.mount(card);
      card.focus?.();

      refreshPairingCode = loadPairingCode;
      void loadPairingCode();
    }

    function closeSettings(options = {}) {
      refreshPairingCode = null;
      overlay.root.getElementById(SETTINGS_ID)?.remove();
      if (options.focus) btn.focus?.();
      scheduleCollapse();
    }

    function showVideos(items) {
      closeSettings();
      hideConfirm();overlay.root.getElementById("__bowerbird_videos")?.remove();
      overlay.root.getElementById("__bowerbird_toast")?.remove();
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
      overlay.mount(card);
      close.focus?.();
    }

    let toastTimer;
    function showToast(text, ok = true, duration = 3000, action = null) {
      clearTimeout(toastTimer);
      let toast = overlay.root.getElementById("__bowerbird_toast");
      if (!toast) {
        toast = document.createElement("div");
        toast.id = "__bowerbird_toast";
        toast.style.cssText = "padding:8px 12px;border-radius:6px;font:13px -apple-system,sans-serif;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:space-between";
        const message = document.createElement("span");
        message.setAttribute("role", "status");
        toast.append(message);
      }
      toast.style.background = ok ? "#2e7d32" : "#c62828";
      toast.firstChild.textContent = text;
      const existing = toast.querySelector("button");
      if (existing && existing.textContent !== action?.label) existing.remove();
      if (action && !toast.querySelector("button")) {
        const button = document.createElement("button");
        button.type = "button";
        button.style.cssText = "padding:4px 8px;border:1px solid currentColor;border-radius:4px;background:#0002;color:inherit;font:inherit;cursor:pointer";
        button.textContent = action.label;
        onUserAction(button, "click", action.run);
        toast.append(button);
      }
      if (!toast.isConnected) overlay.mount(toast);
      if (duration > 0) toastTimer = setTimeout(() => toast.remove(), duration);
    }

    return { closeMenu, closeSettings, toggleMenu, showToast, showVideos };
  }

  globalThis.BowerbirdPanels = { create };
})();
