import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1581, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());

try {
  await mkdir(".tmp/toolbar-layout", { recursive: true });
  for (const mode of ["library", "canvas"]) {
    await page.goto(`http://127.0.0.1:1581/scripts/fixtures/project-drop/preview.html?layout${mode === "canvas" ? "&canvas-toolbar" : ""}`);
    await page.getByRole("button", { name: "探索", exact: true }).waitFor();
    const more=page.getByRole('button',{name:'更多素材库控件',exact:true});
    if(await more.isVisible()) await more.click();
    await page.getByRole('button',{name:'文件浏览器',exact:true}).click();
    await page.getByRole('group',{name:'文件夹地址栏',exact:true}).waitFor();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      // Include the native minimum width and both sides of every toolbar breakpoint.
      for (const width of [900, 980, 981, 1000, 1120, 1121, 1200, 1201, 1280, 1281, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        for (const busy of [false, true]) {
          await page.evaluate(busy => window.store.setState({ loading: busy }), busy);
          await page.waitForFunction(busy => document.querySelector('.app-topbar').getAttribute('aria-busy') === String(busy), busy);
          const layout = await page.locator(".app-topbar").evaluate(el => {
            const bar = el.getBoundingClientRect();
            const groups = [".app-topbar-leading", ".app-topbar-actions"].map(selector => el.querySelector(selector).getBoundingClientRect());
            const controls = [...el.querySelectorAll("button, input")].map(control => control.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0);
            const labels = [...el.querySelectorAll('.app-topbar-button-label')];
            const surfaces = [...el.querySelectorAll('.app-topbar-leading > button, .app-topbar-import > button, .app-search input, .library-view-segments, .app-topbar-actions > button, .task-center-trigger')];
            return {
              height: bar.height,
              aligned: groups.every(box => Math.abs(box.y + box.height / 2 - (groups[0].y + groups[0].height / 2)) < 1),
              searchHidden: el.querySelector('.app-search') === null,
              labelsVisible: labels.every(label => label.getBoundingClientRect().width > 0 && label.getBoundingClientRect().height > 0),
              controlHeights: surfaces.map(control => control.getBoundingClientRect().height),
              controlRadii: surfaces.map(control => getComputedStyle(control).borderTopLeftRadius),
              tactical: el.classList.contains('library-tactical'),
              overflow: el.scrollWidth > el.clientWidth,
              contained: controls.every(box => box.left >= bar.left && box.right <= bar.right && box.top >= bar.top && box.bottom <= bar.bottom),
              overlap: controls.some((a, i) => controls.slice(i + 1).some(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)),
            };
          });
          const context = JSON.stringify({ mode, theme, width, busy, layout });
          assert.equal(layout.height, 64, context);
          assert.equal(layout.aligned, true, context);
          assert.equal(layout.searchHidden, true, context);
          assert.equal(layout.labelsVisible, true, context);
          assert.ok(layout.controlHeights.every(height => height === 36), context);
          assert.ok(layout.controlRadii.every(radius => radius === (layout.tactical ? '0px' : '8px')), context);
          assert.equal(layout.overflow, false, context);
          assert.equal(layout.contained, true, context);
          assert.equal(layout.overlap, false, context);
        }
      }
      await page.evaluate(() => window.store.setState({ loading: false }));
      await page.setViewportSize({ width: 900, height: 900 });
      await page.screenshot({ path: `.tmp/toolbar-layout/${mode}-${theme}-900.png` });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({ path: `.tmp/toolbar-layout/${mode}-${theme}-1280.png` });
    }
    // Hidden search has no keyboard focus target; menus remain unclipped.
    await page.setViewportSize({ width: 900, height: 900 });
    assert.equal(await page.getByRole("button", { name: "打开本机文件资源管理器", exact: true }).count(), 0);
    await page.getByRole("button", { name: "导入", exact: true }).focus();
    await page.keyboard.press("/");
    assert.equal(await page.getByRole("button", { name: "导入", exact: true }).evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('.app-search').count(),0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "导入", exact: true }).click();
    const importItem = page.getByRole("menuitem", { name: "导入图片或视频", exact: true });
    await importItem.waitFor();
    assert.equal(await importItem.evaluate(el => {
      const box = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }), true);
  }
  assert.deepEqual(errors, []);
  console.log("Toolbar layout: library/canvas, light/dark, 900–1920px, idle/importing, hidden search, uniform controls, single row, no overlaps/clipping and import popup passed.");
} finally {
  await browser.close();
  await server.close();
}
