// Shared by the trusted workspace and the isolated source WebView. No IPC here.
// Source pages only draw their own image; library labels stay in the main view.
(() => {
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
      const width = Math.max(80, Math.min(164, (bounds.right - bounds.left - 152) / 2));
      chips.style.setProperty("--fan-width", `${width}px`);
      x = Math.max(bounds.left + (hasPreview ? width + 10 : 18), Math.min(bounds.right - (hasPreview ? 130 + width : 124), x));
      y = Math.max(bounds.top + (hasPreview ? 220 + width * .28 : 116), Math.min(bounds.bottom - (hasPreview ? 120 + width * .28 : 84), y));
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
        .root { font:12px/1.35 system-ui,sans-serif; color:#26342f; pointer-events:none; }
        .card { position:absolute;left:14px;top:-104px;width:96px;height:112px;padding:5px;border-radius:14px;
          background:#fff;box-shadow:0 18px 32px #172e3933,0 3px 7px #172e3926;transform:rotate(-7deg);transform-origin:12px 100%; }
        .paper { width:100%;height:100%;border-radius:10px;overflow:hidden;background:linear-gradient(135deg,#d8e7e2,#b0c9c1); }
        img { width:100%;height:100%;object-fit:contain;display:block; }
        .grip { position:absolute;left:-10px;top:-14px;width:30px;height:30px;border-radius:50%;background:#253b33;
          color:white;display:grid;place-items:center;box-shadow:0 3px 10px #142a3840;border:2px solid white; }
        .grip svg { width:18px;height:18px; }
        .chips { position:absolute;left:0;top:0; }
        .chip { position:absolute;width:0;height:0;transform-origin:0 0;
          animation:pop 340ms cubic-bezier(.2,.9,.25,1.3) both; }
        .chip:nth-child(odd) { left:2px;--direction:1; }
        .chip:nth-child(even) { left:120px;--direction:-1; }
        .chip:nth-child(-n+2) { top:-112px;--vertical:-1; }
        .chip:nth-child(n+3) { top:16px;--vertical:1; }
        .chip:nth-child(2) { animation-delay:90ms; }
        .chip:nth-child(3) { animation-delay:180ms; }
        .chip:nth-child(4) { animation-delay:270ms; }
        .candidate,.empty { position:absolute;width:var(--fan-width);height:28px;padding:5px 9px;
          border:1px solid #dce9e3;border-radius:14px;background:#fff;color:#24483a;box-shadow:0 4px 12px #173d3118; }
        .candidate { display:flex;gap:8px;align-items:baseline;line-height:16px; }
        .chip:nth-child(odd) > * { right:0;transform-origin:100% 50%; }
        .chip:nth-child(even) > * { left:0;transform-origin:0 50%; }
        .chip:nth-child(-n+2) > * { top:-28px; }
        .chip:nth-child(n+3) > * { top:0; }
        .candidate:first-child { font-weight:700; }
        .candidate[data-selected=false] { font-weight:400;opacity:.62; }
        .name { flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .probability { flex:none;font-variant-numeric:tabular-nums; }
        .caption { position:absolute;left:0;top:38px;white-space:nowrap;color:#5b7066;background:#fffffff0;border-radius:10px;padding:3px 7px; }
        .caption:empty { display:none; }
        .ring { display:none;position:absolute;left:-68px;top:36px;width:136px;height:30px;border:2px solid #729b88;border-radius:50%; }
        .root[data-phase=landing] .card { left:-48px;top:-56px;transform:rotate(0);transform-origin:50% 100%; }
        .root[data-phase=landing] .grip,.root[data-phase=landing] .chips { display:none; }
        .root[data-phase=landing] .caption { left:0;top:68px;transform:translateX(-50%); }
        .root[data-phase=landing] .ring { display:block;animation:impact 650ms ease-out both; }
        @keyframes pop { from { opacity:0;transform:translateY(10px) scale(.6); } to { opacity:1;transform:none; } }
        @keyframes impact { 0%,35% { opacity:0;transform:scale(.4); } 45% { opacity:.65; } 100% { opacity:0;transform:scale(1.6); } }
        :host([data-theme=dark]) .card,:host([data-theme=dark]) .candidate,:host([data-theme=dark]) .empty { background:#25352f;color:#e5f2eb;border-color:#496056; }
        :host([data-theme=dark]) .caption { background:#25352ff0;color:#d1e5d9; }
        @media(prefers-reduced-motion:reduce) { .chip,.root[data-phase=landing] .ring { animation:none; } .ring { visibility:hidden; } }
      </style><div class="root" data-phase="carry"><div class="ring"></div><div class="card"><div class="paper"><img alt="" draggable="false"></div></div>
        <div class="grip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12V8a2 2 0 0 1 4 0v3-5a2 2 0 0 1 4 0v5-3a2 2 0 0 1 4 0v7c0 4-2 6-6 6h-1c-3 0-4-2-6-4l-3-4a2 2 0 0 1 3-2l1 1Z"/></svg></div>
        <div class="chips"></div><div class="caption"></div></div>`;
      root = shadow.querySelector(".root"); card = shadow.querySelector(".card"); picture = shadow.querySelector("img");
      chips = shadow.querySelector(".chips"); caption = shadow.querySelector(".caption");
      picture.onerror = () => { picture.style.opacity = "0"; };
      picture.onload = () => { picture.style.opacity = "1"; };
      picture.src = value.imageUrl;
      parent.append(host);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        move(x, y);
        if (!reduced()) {
          const position = new DOMMatrixReadOnly(getComputedStyle(host).transform);
          const from = sourceRect ? `translate(${sourceRect.left - position.m41 - 14}px,${sourceRect.top - position.m42 + 104}px) scale(${sourceRect.width / 96},${sourceRect.height / 112})` : "rotate(-12deg) scale(.85)";
          card.animate([{ transform: from, opacity: .65, transformOrigin: "0 0" },
            { transform: "rotate(-7deg) scale(1)", opacity: 1, transformOrigin: "0 0" }],
          { duration: sourceRect ? 340 : 140, easing: "cubic-bezier(.18,.85,.25,1)" });
        }
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
          { transform: "translate(62px,-48px) rotate(-7deg) scale(.95)" },
          { offset: .45, transform: "translateY(7px) scale(1.13,.82)" },
          { offset: .67, transform: "translateY(-8px) scale(.97,1.04)" },
          { offset: .85, transform: "translateY(2px) scale(1.025,.97)" },
          { transform: "none" },
        ], { duration: 560, easing: "cubic-bezier(.3,.05,.65,1)" });
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
        }, reduced() ? 0 : Math.max(0, 560 - (performance.now() - landedAt)));
      },
    };
  };
})();
