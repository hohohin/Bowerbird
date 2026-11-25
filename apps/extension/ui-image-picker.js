(() => {
  "use strict";

  const SMALL_IMAGE_EDGE = 200;
  const BUTTON_STYLE = "border:0;padding:6px 12px;border-radius:6px;cursor:pointer;font:inherit;color:#fff;background:#3a3f4f";
  const PICKER_ID = "__bowerbird_confirm";

  function create(batch, { onUserAction, onCancel, onCollect }) {
    const card = document.createElement("section");
    card.id = PICKER_ID;
    card.tabIndex = -1;
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "选择要采集的图片");
    card.style.cssText = "padding:12px 14px;border-radius:10px;background:#1f2330;color:#fff;font:13px -apple-system,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4)";

    const title = document.createElement("strong");
    title.textContent = batch.label.replace(/，全部采集？$/, "");
    title.style.fontSize = "14px";

    const controls = document.createElement("div");
    controls.style.cssText = "display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin:10px 0";
    const toggleAll = document.createElement("button");
    toggleAll.type = "button";
    toggleAll.style.cssText = BUTTON_STYLE;
    const smallLabel = document.createElement("label");
    smallLabel.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer";
    const hideSmall = document.createElement("input");
    hideSmall.type = "checkbox";
    smallLabel.title = "隐藏已知宽或高不足 200 像素的图片";
    smallLabel.append(hideSmall, "过滤小图");
    controls.append(toggleAll, smallLabel);

    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:8px;max-height:34vh;overflow:auto;padding:3px;overscroll-behavior:contain";
    const empty = document.createElement("p");
    empty.textContent = "没有符合筛选条件的图片";
    empty.style.cssText = "margin:8px 0;color:#c6cad7";

    const status = document.createElement("span");
    status.setAttribute("role", "status");
    status.style.cssText = "margin-right:auto;color:#c6cad7";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:12px";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.style.cssText = BUTTON_STYLE;
    const collect = document.createElement("button");
    collect.type = "button";
    collect.textContent = "采集";
    collect.style.cssText = BUTTON_STYLE + ";background:#7c9cff;color:#10131c;font-weight:600";
    actions.append(status, cancel, collect);

    const tiles = batch.items.map((item, index) => {
      const tile = document.createElement("label");
      tile.style.cssText = "position:relative;display:flex;aspect-ratio:1;min-width:0;border:1px solid #555c70;border-radius:6px;overflow:hidden;background:#151821;cursor:pointer";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.setAttribute("aria-label", `图片 ${index + 1}`);
      checkbox.style.cssText = "position:absolute;top:4px;left:4px;z-index:1;accent-color:#7c9cff;width:16px;height:16px;margin:0";
      const image = document.createElement("img");
      image.alt = "";
      image.draggable = false;
      image.loading = "lazy";
      image.decoding = "async";
      image.style.cssText = "width:100%;height:100%;object-fit:contain;pointer-events:none";
      image.src = item.media_url;
      tile.append(image, checkbox);
      grid.append(tile);
      return { item, tile, checkbox, image, selected: true, visible: true };
    });

    function update() {
      let selected = 0;
      let visible = 0;
      for (const entry of tiles) {
        const { item, tile, checkbox, image } = entry;
        const width = item.width || image.naturalWidth;
        const height = item.height || image.naturalHeight;
        const small = (width > 0 && width < SMALL_IMAGE_EDGE) || (height > 0 && height < SMALL_IMAGE_EDGE);
        entry.visible = !hideSmall.checked || !small;
        tile.style.display = entry.visible ? "flex" : "none";
        tile.style.borderColor = entry.selected ? "#7c9cff" : "#555c70";
        checkbox.checked = entry.selected;
        if (!entry.visible) continue;
        visible += 1;
        if (entry.selected) selected += 1;
      }
      empty.style.display = visible ? "none" : "block";
      status.textContent = `已选 ${selected} / ${visible}`;
      toggleAll.textContent = visible && selected === visible ? "全不选" : "全选";
      toggleAll.disabled = visible === 0;
      collect.disabled = selected === 0;
      collect.style.opacity = selected ? "1" : ".55";
    }

    for (const entry of tiles) {
      onUserAction(entry.checkbox, "change", () => {
        entry.selected = entry.checkbox.checked;
        update();
      });
      entry.image.addEventListener("load", () => { if (hideSmall.checked) update(); });
    }
    onUserAction(hideSmall, "change", update);
    onUserAction(toggleAll, "click", () => {
      const visible = tiles.filter(entry => entry.visible);
      const select = visible.some(entry => !entry.selected);
      for (const entry of visible) entry.selected = select;
      update();
    });
    onUserAction(cancel, "click", onCancel);
    onUserAction(collect, "click", () => onCollect(tiles.filter(entry => entry.visible && entry.selected).map(entry => entry.item)));
    card.addEventListener("mousedown", event => event.stopPropagation());
    card.append(title, controls, grid, empty, actions);
    update();
    return card;
  }

  globalThis.BowerbirdImagePicker = { create };
})();
