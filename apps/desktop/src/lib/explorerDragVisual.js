// Shared by the trusted workspace and the isolated source WebView. No IPC here.
// Source pages only draw their own image; library labels stay in the main view.
(() => {
  function previewSize(width, height) {
    const scale = Math.min(96 / width, 112 / height, 1);
    return { width: width * scale, height: height * scale };
  }
  function animatePickup(card, sourceRect) {
    const rect = card.getBoundingClientRect();
    const from = sourceRect ? `translate(${sourceRect.left - rect.left}px,${sourceRect.top - rect.top}px) scale(${sourceRect.width / rect.width},${sourceRect.height / rect.height})` : "translateY(6px)";
    card.animate([{ transform: from, opacity: .65, transformOrigin: "0 0" },
      { transform: "none", opacity: 1, transformOrigin: "0 0" }], { duration: 180, easing: "ease-out" });
  }
  window.createBowerbirdDragVisual = (parent = document.body) => {
    let host, root, card, picture, chips, caption, id, landing = false, timer, landedAt = 0;
    let pointer, hasPreview = false;
    const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
    const clear = () => {
      clearTimeout(timer);
      host?.remove(); host = null; id = null; landing = false; pointer = null; hasPreview = false;
    };
    const move = (x, y) => {
      if (!host || landing) return;
      pointer = { x, y };
      const bounds = parent === document.body ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight } : parent.getBoundingClientRect();
      // Leave room for the carried card and its surrounding chips at panel edges.
      const previewWidth = card.offsetWidth, previewHeight = card.offsetHeight;
      const width = Math.max(40, Math.min(164, (bounds.right - bounds.left - previewWidth - 56) / 2));
      chips.style.setProperty("--fan-width", `${width}px`);
      x = Math.max(bounds.left + (hasPreview ? width + 8 : 6), Math.min(bounds.right - previewWidth - 20 - (hasPreview ? width + 12 : 0), x));
      y = Math.max(bounds.top + previewHeight + (hasPreview ? 48 : 18), Math.min(bounds.bottom - (hasPreview ? 68 : 18), y));
      host.style.visibility = "visible";
      host.style.transform = `translate3d(${x}px,${y}px,0)`;
    };
    const pick = (value, x, y, sourceRect) => {
      clear(); id = value.id;
      host = document.createElement("div");
      host.dataset.explorerDragVisual = "";
      host.dataset.theme = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light");
      host.setAttribute("aria-hidden", "true");
      host.style.cssText = "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;visibility:hidden";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `<style>
        :host { pointer-events:none!important; }
        * { box-sizing:border-box; }
        .root { --preview-width:96px;--preview-height:112px;--surface:var(--bb-surface,#F7F7F7);--ink:var(--bb-ink,#2B2B2B);--muted:var(--bb-muted,#646464);
          --line:var(--bb-line,#C5C5C5);--accent:var(--bb-blue,#496775);--shadow:0 3px 5px -3px rgb(33 39 43 / .23),0 18px 28px -10px rgb(33 39 43 / .26);
          font:12px/1.35 Inter,"Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;color:var(--ink);pointer-events:none; }
        .card { position:absolute;left:14px;top:calc(-1 * var(--preview-height) - 12px);
          width:var(--preview-width);height:var(--preview-height);padding:0;border-radius:0;background:transparent;box-shadow:var(--shadow); }
        .card:not([data-ready]) { visibility:hidden; }
        .card::before,.card::after { content:"";position:absolute;width:4.8px;height:4.8px;background:var(--accent);z-index:1; }
        .card::before { top:-2.4px;right:-2.4px; }.card::after { bottom:-2.4px;left:-2.4px; }
        .paper { width:100%;height:100%;background:transparent; }
        img { width:100%;height:100%;object-fit:contain;display:block; }
        .chips { position:absolute;left:0;top:0; }
        .chip { position:absolute;width:0;height:0;transform-origin:0 0;
          animation:pop 340ms cubic-bezier(.2,.9,.25,1.3) both; }
        .chip:nth-child(odd) { left:2px;--direction:1; }
        .chip:nth-child(even) { left:calc(var(--preview-width) + 24px);--direction:-1; }
        .chip:nth-child(-n+2) { top:calc(-1 * var(--preview-height) - 20px);--vertical:-1; }
        .chip:nth-child(n+3) { top:4px;--vertical:1; }
        .chip:nth-child(2) { animation-delay:90ms; }
        .chip:nth-child(3) { animation-delay:180ms; }
        .chip:nth-child(4) { animation-delay:270ms; }
        .candidate,.empty { position:absolute;width:var(--fan-width);height:28px;padding:5px 9px;
          border:1px solid var(--line);border-radius:2px;background:var(--surface);color:var(--ink);box-shadow:var(--shadow); }
        .candidate { display:flex;gap:8px;align-items:baseline;line-height:16px; }
        .chip:nth-child(odd) > * { right:0;transform-origin:100% 50%; }
        .chip:nth-child(even) > * { left:0;transform-origin:0 50%; }
        .chip:nth-child(-n+2) > * { top:-28px; }
        .chip:nth-child(n+3) > * { top:0; }
        .candidate:first-child { font-weight:700; }
        .candidate[data-selected=false] { font-weight:400;opacity:.62; }
        .name { flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .probability { flex:none;font-variant-numeric:tabular-nums; }
        .caption { position:absolute;left:calc(14px + var(--preview-width) / 2);top:40px;transform:translateX(-50%);
          width:max-content;max-width:calc(var(--preview-width) + 2 * var(--fan-width));overflow:hidden;text-overflow:ellipsis;
          white-space:nowrap;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:2px;padding:3px 7px; }
        .caption:empty { display:none; }
        .root[data-phase=landing] .card { left:calc(-1 * var(--preview-width) / 2);top:calc(-1 * var(--preview-height) / 2); }
        .root[data-phase=landing] .chips { display:none; }
        .root[data-phase=landing] .caption { left:0;top:calc(var(--preview-height) / 2 + 12px); }
        @keyframes pop { from { opacity:0;transform:translateY(10px) scale(.6); } to { opacity:1;transform:none; } }
        :host([data-theme=dark]) .root { --surface:var(--bb-surface,#1E1E1E);--ink:var(--bb-ink,#DCDCDC);--muted:var(--bb-muted,#949494);--line:var(--bb-line,#3D3D3D);--accent:var(--bb-blue,#8FAAB8);
          --shadow:0 4px 6px -3px rgb(0 0 0 / .70),0 20px 32px -11px rgb(0 0 0 / .62); }
        @media(prefers-reduced-motion:reduce) { .chip { animation:none; } }
      </style><div class="root" data-phase="carry"><div class="card"><div class="paper"><img alt="" draggable="false"></div></div>
        <div class="chips"></div><div class="caption"></div></div>`;
      root = shadow.querySelector(".root"); card = shadow.querySelector(".card"); picture = shadow.querySelector("img");
      chips = shadow.querySelector(".chips"); caption = shadow.querySelector(".caption");
      const currentPicture = picture;
      picture.onerror = () => { if (picture === currentPicture) card.removeAttribute("data-ready"); };
      picture.onload = () => {
        if (picture !== currentPicture || !host) return;
        const firstFrame = !card.hasAttribute("data-ready");
        const size = previewSize(picture.naturalWidth, picture.naturalHeight);
        root.style.setProperty("--preview-width", `${size.width}px`);
        root.style.setProperty("--preview-height", `${size.height}px`);
        card.dataset.ready = "";
        if (pointer) move(pointer.x, pointer.y);
        if (firstFrame && !landing && !reduced()) animatePickup(card, sourceRect);
      };
      if (value.imageUrl) picture.src = value.imageUrl;
      parent.append(host);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        move(x, y);
      }
      timer = setTimeout(clear, 180000);
    };
    return {
      pick, move, clear,
      hide() { if (host && !landing) host.style.visibility = "hidden"; },
      update(value) {
        if (!host || value.id !== id || landing) return;
        if (value.thumbnail) picture.src = value.thumbnail;
        if (value.labels) {
          chips.replaceChildren(...value.labels.slice(0, 4).map((label, index) => {
            const chip = document.createElement("div"); chip.className = "chip"; chip.dataset.rank = String(index + 1);
            const row = document.createElement("div"); row.className = "candidate"; row.dataset.selected = String(label.selected);
            const name = document.createElement("span"); name.className = "name";
            name.textContent = label.key === "no_match" ? "无明显匹配项" : `#${label.name}`;
            name.title = label.name;
            const score = document.createElement("span"); score.className = "probability";
            const percent = label.probability * 100;
            score.textContent = percent > 0 && percent < .1 ? "<0.1%" : `${Number(percent.toFixed(1))}%`;
            row.append(name, score); chip.append(row);
            return chip;
          }));
          if (!value.labels.length) {
            const chip = document.createElement("div"); chip.className = "chip";
            const empty = document.createElement("span"); empty.className = "empty"; empty.textContent = "暂无已有标签";
            chip.append(empty); chips.append(chip);
          }
          caption.textContent = "Jev 候选概率 · ≥42% 入选，最多 3 项";
          hasPreview = true;
          if (pointer) move(pointer.x, pointer.y);
        }
      },
      land(x, y) {
        if (!host) return;
        landing = true; landedAt = performance.now(); host.style.visibility = "visible";
        host.style.transform = `translate3d(${x}px,${y}px,0)`;
        root.dataset.phase = "landing"; caption.textContent = "采集中…";
        if (!reduced()) card.animate([
          { transform: "translateY(-8px)" },
          { transform: "none" },
        ], { duration: 180, easing: "ease-out" });
      },
      settle(element) {
        if (!host) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (element?.isConnected && !reduced()) element.animate([
            { translate: "0 -16px", scale: "1" }, { offset: .36, translate: "0 4px", scale: "1.035 .96" },
            { offset: .64, translate: "0 -4px", scale: ".99 1.01" }, { translate: "0 0", scale: "1" },
          ], { duration: 430, easing: "ease-out" });
          clear();
        }, reduced() ? 0 : Math.max(0, 180 - (performance.now() - landedAt)));
      },
    };
  };
})();
