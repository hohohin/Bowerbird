// Use the browser's own drag input and populate its data at the source.
export async function dropData(page, target, values) {
  const source = page.locator("#drag-fixture");
  await page.evaluate(values => {
    document.getElementById("drag-fixture")?.remove();
    const node = document.createElement("div");
    node.id = "drag-fixture";
    node.textContent = "Drag sample";
    node.draggable = true;
    node.style.cssText = "position:fixed;top:10px;right:10px;width:100px;height:40px;z-index:2147483647";
    node.addEventListener("dragstart", event => {
      for (const [format, value] of Object.entries(values)) event.dataTransfer.setData(format, value);
    });
    document.body.append(node);
  }, values);
  await source.dragTo(target);
  await source.evaluate(el => el.remove());
}
