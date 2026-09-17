import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1576, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
const toggle = page.getByRole("group", { name: "辅助", exact: true }).getByRole("button", { name: "吸附对齐" });
const guides = axis => page.locator(`.canvas-snap-guide.is-${axis}`);
async function reset(zoom) {
  await page.evaluate(zoom => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    snapshot.nodes = [
      { ...base, id: "stationary", assetId: "a", x: 100, y: 200, width: 190 },
      { ...base, id: "moving", assetId: "b", x: 850, y: 600, width: 190 },
    ];
    snapshot.edges = []; snapshot.groups = []; snapshot.groupItems = [];
    snapshot.view = { ...snapshot.view, zoom, panX: 0, panY: 100 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
    localStorage.removeItem("bowerbird.canvasSnapEnabled");
  }, zoom);
  await page.reload(); await node("moving").waitFor();
}
async function dragTo(x, y) {
  const box = await node("moving").boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
  await page.mouse.move(x + 20, y + 20, { steps: 6 });
}
try {
  await page.goto("http://127.0.0.1:1576/scripts/fixtures/canvas-reference/preview.html");
  await node("old").waitFor();
  for (const zoom of [1, 0.5]) for (const axis of ["x", "y"]) {
    await reset(zoom);
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    const stationary = await node("stationary").boundingBox();
    const raw = axis === "y"
      ? { x: stationary.x + 550 * zoom, y: stationary.y + 18 }
      : { x: stationary.x + 18, y: stationary.y + 500 * zoom };
    await dragTo(raw.x, raw.y);
    const aligned = await node("moving").boundingBox();
    assert.ok(Math.abs(aligned[axis] - stationary[axis]) < 0.01);
    const freeAxis = axis === "x" ? "y" : "x";
    assert.ok(Math.abs(aligned[freeAxis] - raw[freeAxis]) < 0.01, "preserve the gap in the free direction");
    assert.equal(await guides(axis).count(), 2);
    assert.equal(await guides(freeAxis).count(), 0);
    const guideStyles = await guides(axis).evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      return { image: style.backgroundImage, width: box.width, height: box.height };
    }));
    assert.ok(guideStyles.every(style => style.image.includes("linear-gradient")));
    assert.ok(guideStyles.every(style => Math.abs((axis === "x" ? style.width : style.height) - 1) < 0.01));
    if (zoom === 1 && axis === "y") {
      await mkdir(".tmp/canvas-snap", { recursive: true });
      await page.screenshot({ path: ".tmp/canvas-snap/alignment.png" });
    }
    await page.mouse.up();
    assert.equal(await page.locator(".canvas-snap-guide").count(), 0);
    assert.deepEqual(await node("stationary").boundingBox(), stationary);

    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    await dragTo(raw.x, raw.y);
    const free = await node("moving").boundingBox();
    assert.ok(Math.abs(free[axis] - raw[axis]) < 0.01);
    assert.equal(await page.locator(".canvas-snap-guide").count(), 0);
    await page.mouse.up();
    await page.reload(); await node("moving").waitFor();
    assert.equal(await toggle.getAttribute("aria-pressed"), "false", "remember the switch after reload");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  }
  assert.deepEqual(errors, []);
  console.log("PASS left toolbar snap toggle, remembered state, spaced horizontal/vertical alignment, paired dashed guides at 100%/50%, free placement and stationary anchors.");
} finally { await browser.close(); await server.close(); }
