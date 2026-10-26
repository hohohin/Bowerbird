import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1643, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
// Embedded browsers may remain visible and receive pointer events without native focus.
await page.addInitScript(() => { Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false }); });
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
const output = ".tmp/library-tactical";
const card = page.locator(".folder-media-card").first();
const geometrySelectors = [".app-topbar", ".topbar-account-trigger", ".catalog-sidebar", ".catalog-alphabet", ".library-view-switch", ".library-media-switch", ".thumbnail-size-slider", ".catalog-section-title", ".folder-media-card"];
async function geometry() {
  return page.evaluate(selectors => Object.fromEntries(selectors.map(selector => [selector, [...document.querySelectorAll(selector)].slice(0, 3).map(element => {
    const rect = element.getBoundingClientRect();
    return [rect.x, rect.y, rect.width, rect.height];
  })])), geometrySelectors);
}
async function setTacticalStyles(enabled) {
  await page.evaluate(value => {
    const sheets = [...document.styleSheets].filter(sheet => sheet.ownerNode?.getAttribute("data-vite-dev-id")?.endsWith("/LibraryTactical.css"));
    if (!sheets.length) throw new Error("Production LibraryTactical.css was not loaded");
    sheets.forEach(sheet => { sheet.disabled = !value; });
  }, enabled);
  await page.waitForTimeout(250);
}
try {
  await mkdir(output, { recursive: true });
  await page.goto("http://127.0.0.1:1643/scripts/fixtures/library-tactical/preview.html");
  await card.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll(".folder-media-card img")].some(image => image.complete && image.naturalWidth));
  await page.waitForTimeout(650);
  assert.equal(await page.locator('link[href*=".tmp"],style[data-vite-dev-id*=".tmp"]').count(), 0, "fixture uses production CSS only");

  // Turning off only the new paint layer must preserve the established library geometry.
  for (const width of [1500, 900, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(350);
    const styled = await geometry();
    const sentinel = await page.locator("[data-unrelated-control]").evaluate(element => getComputedStyle(element).cssText + getComputedStyle(element).background + getComputedStyle(element).borderRadius);
    await setTacticalStyles(false);
    const original = await geometry();
    assert.equal(await page.locator("[data-unrelated-control]").evaluate(element => getComputedStyle(element).cssText + getComputedStyle(element).background + getComputedStyle(element).borderRadius), sentinel, "new rules do not affect unrelated controls");
    for (const selector of geometrySelectors) {
      assert.equal(styled[selector].length, original[selector].length);
      styled[selector].forEach((box, index) => box.forEach((value, axis) => assert.ok(Math.abs(value - original[selector][index][axis]) < 1, `${width}px ${selector} changed layout: ${JSON.stringify({ styled: box, original: original[selector][index] })}`)));
    }
    await setTacticalStyles(true);
  }
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.waitForTimeout(350);

  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    const controls = await page.evaluate(() => [".app-topbar-import > button", ".topbar-account-trigger", ".library-view-switch", ".library-media-switch", '.library-filter-trigger[aria-label="文件浏览器"]', ".thumbnail-size-slider"].map(selector => {
      const element = document.querySelector(selector), style = getComputedStyle(element);
      return { selector, radius: style.borderRadius, image: style.backgroundImage, alpha: Number(style.backgroundColor.match(/[\d.]+/g).at(-1)), blur: style.backdropFilter, point: getComputedStyle(element, "::after").content };
    }));
    assert.ok(controls.every(control => control.radius === "0px" && control.image === "none" && control.blur === "none" && control.alpha < .8 && control.point === "none"), `${theme}: ${JSON.stringify(controls)}`);
    const activeTab = page.getByRole("tab", { name: "标签分类", exact: true });
    const point = await activeTab.evaluate(element => { const style = getComputedStyle(element, "::after"); return { content: style.content, width: style.width, height: style.height, right: style.right, bottom: style.bottom }; });
    assert.deepEqual(point, { content: '""', width: "2px", height: "2px", right: "3px", bottom: "3px" }, "only highlighted controls expose the lower-right point");
    await page.screenshot({ path: `${output}/${theme}.png` });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });

  const importButton = page.locator(".app-topbar-import > button");
  assert.deepEqual(await page.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus() })), { hidden: false, focused: false });
  await importButton.hover();
  const controlFlash = await importButton.evaluate(element => {
    const animations = element.getAnimations({ subtree: true });
    const animation = animations.find(item => item.animationName === "library-tactical-control-contact");
    const point = animations.find(item => item.animationName === "library-tactical-contact");
    if (!animation || !point) return { missing: true, control: !!animation, point: !!point, paused: element.closest(".library-tactical").dataset.libraryMotionPaused };
    const running = animation.playState === "running" && point.playState === "running";
    animation.pause(); animation.currentTime = 30; const bright = Number(getComputedStyle(element).opacity);
    animation.currentTime = 70; const dim = Number(getComputedStyle(element).opacity);
    point.pause(); point.currentTime = 0; const pointBright = Number(getComputedStyle(element, "::after").opacity);
    point.currentTime = 30; const pointDim = Number(getComputedStyle(element, "::after").opacity);
    animation.finish(); point.finish();
    return { running, bright, dim, pointBright, pointDim, duration: animation.effect.getTiming().duration, pointDuration: point.effect.getTiming().duration };
  });
  assert.ok(!controlFlash.missing && controlFlash.running && controlFlash.bright > controlFlash.dim && controlFlash.pointBright > controlFlash.pointDim, `visible unfocused page must run control and corner-point flashes: ${JSON.stringify(controlFlash)}`);
  assert.equal(controlFlash.duration, 160); assert.equal(controlFlash.pointDuration, 160);
  await page.mouse.move(0, 0);
  assert.equal(await importButton.evaluate(element => getComputedStyle(element, "::after").content), "none");

  const colors = page.getByRole("button", { name: "颜色筛选", exact: true });
  await colors.click();
  await page.waitForTimeout(200);
  const selectedColor = await page.locator(".library-view-switch-thumb").evaluate(element => getComputedStyle(element).backgroundColor);
  assert.equal(await colors.evaluate(element => getComputedStyle(element).backgroundColor), selectedColor, "open filter retains active paint while hovered");
  assert.ok(await page.locator(".library-filter-colors button").evaluateAll(elements => elements.every(element => getComputedStyle(element).borderRadius === "0px")));
  await page.getByRole("button", { name: "红", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => [...document.querySelectorAll(".folder-media-card")].length > 0 && [...document.querySelectorAll(".folder-media-card")].every(element => Number(element.dataset.assetId.split("-")[1]) % 2 === 1));
  assert.equal(await colors.getAttribute("data-active"), "true");
  await colors.click(); await page.getByRole("button", { name: "清除颜色筛选", exact: true }).click(); await page.keyboard.press("Escape");
  await page.locator('[data-asset-id="tactical-0"]').waitFor();

  await card.hover();
  const motion = await card.evaluate(element => {
    const animations = element.getAnimations({ subtree: true });
    const spread = animations.find(item => item.animationName === "library-tactical-card-spread");
    const flash = animations.find(item => item.animationName === "library-tactical-card-contact");
    if (!spread || !flash) return null;
    const running = spread.playState === "running" && flash.playState === "running";
    spread.pause(); flash.pause(); flash.currentTime = 0;
    spread.currentTime = 0; const start = getComputedStyle(element, "::after").backgroundPosition;
    spread.currentTime = 200; const middle = getComputedStyle(element, "::after").backgroundPosition;
    spread.finish(); const end = getComputedStyle(element, "::after").backgroundPosition;
    const opacity = [350, 410, 450, 490, 530].map(time => { flash.currentTime = time; return Number(getComputedStyle(element, "::after").opacity); });
    flash.finish();
    const marker = getComputedStyle(element, "::after"), preview = element.querySelector(".folder-media-preview");
    return { running, start, middle, end, opacity, duration: spread.effect.getTiming().duration, flash: flash.effect.getTiming(), size: marker.backgroundSize,
      inset: marker.inset, pointer: marker.pointerEvents, overflow: getComputedStyle(element).overflow, previewOverflow: getComputedStyle(preview).overflow,
      imageCorners: preview.offsetLeft === 0 && preview.offsetTop === 0 && preview.offsetWidth === element.clientWidth && preview.offsetHeight === element.clientHeight };
  });
  assert.ok(motion, "hover starts both position and delayed flicker animations");
  assert.ok(motion.running, "visible unfocused page runs card spread and delayed flashes");
  assert.equal(motion.duration, 400); assert.equal(motion.flash.duration, 160); assert.equal(motion.flash.delay, 400);
  assert.equal(motion.start, "50% 50%, 50% 50%, 50% 50%, 50% 50%");
  assert.equal(motion.end, "0% 0%, 100% 0%, 0% 100%, 100% 100%");
  assert.notEqual(motion.middle, motion.start); assert.notEqual(motion.middle, motion.end);
  assert.ok(motion.opacity[0] >= .8); assert.deepEqual(motion.opacity.slice(1), [0, 1, 0, 1], "two full dark/bright pulses occur only after arrival");
  assert.equal(motion.size, "4px 4px, 4px 4px, 4px 4px, 4px 4px");
  assert.equal(motion.inset, "-2px"); assert.equal(motion.pointer, "none"); assert.equal(motion.overflow, "visible"); assert.equal(motion.previewOverflow, "hidden"); assert.ok(motion.imageCorners, "4px markers centered at image vertices, not inside the image");
  await page.screenshot({ path: `${output}/hover.png` });
  await card.click({ modifiers: ["Control"] }); await page.mouse.move(0, 0);
  assert.equal(await card.getAttribute("aria-pressed"), "true");
  assert.equal(await card.evaluate(element => getComputedStyle(element, "::after").opacity), "1", "selected points persist after pointer exit");
  await page.getByRole("button", { name: "取消选择", exact: true }).click();

  const backdrop = await page.locator(".library-tactical-backdrop").first().evaluate(element => {
    const box = element.getBoundingClientRect(), gallery = element.parentElement.getBoundingClientRect();
    const sidebar = document.querySelector(".catalog-sidebar").getBoundingClientRect(), alphabet = document.querySelector(".catalog-alphabet").getBoundingClientRect();
    const slider = document.querySelector(".thumbnail-size-slider").getBoundingClientRect(), style = getComputedStyle(element);
    return { safe: box.left >= Math.max(sidebar.right, alphabet.right) && box.top >= gallery.top + 52 && box.bottom <= gallery.bottom - 56 && box.bottom <= slider.top,
      z: Number(style.zIndex), pointer: style.pointerEvents, mask: getComputedStyle(element, "::before").maskSize, hidden: element.getAttribute("aria-hidden") };
  });
  assert.ok(backdrop.safe); assert.ok(backdrop.z < 0); assert.equal(backdrop.pointer, "none"); assert.equal(backdrop.mask, "96px 88px"); assert.equal(backdrop.hidden, "true");
  await page.locator(".catalog-scroller").evaluate(element => { element.scrollTop = 220; });
  const pinnedTitle = page.locator(".catalog-section-heading.is-pinned .catalog-section-title").first();
  await pinnedTitle.waitFor();
  assert.equal(await pinnedTitle.evaluate(element => getComputedStyle(element).borderRadius), "0px", "scrolled sticky title retains straight corners");
  await page.screenshot({ path: `${output}/pinned.png` });
  await page.locator(".catalog-scroller").evaluate(element => { element.scrollTop = 0; });
  await page.getByRole("button", { name: "视频", exact: true }).click();
  await page.locator('[data-asset-id="video-0"]').waitFor();
  await card.hover();
  assert.equal(await card.evaluate(element => getComputedStyle(element, "::after").inset), "-2px", "video card uses the same markers");
  await page.getByRole("button", { name: "图片", exact: true }).click();
  await page.locator('[data-asset-id="tactical-0"]').waitFor();

  await importButton.focus(); await page.keyboard.press("Tab"); await page.getByRole("tab", { name: "标签分类", exact: true }).focus();
  assert.ok(await page.getByRole("tab", { name: "标签分类", exact: true }).evaluate(element => element.matches(":focus-visible") && getComputedStyle(element).outlineStyle !== "none"), "keyboard focus remains visible");
  await card.hover();
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  assert.ok(await card.evaluate(element => element.closest(".library-motion-root").dataset.libraryMotionPaused === "true" && element.getAnimations({ subtree: true }).filter(animation => animation.animationName?.startsWith("library-tactical-")).every(animation => animation.playState !== "running")), "hidden library stops transient animations");
  await importButton.hover();
  assert.ok(await importButton.evaluate(element => getComputedStyle(element).animationName === "none" && getComputedStyle(element, "::after").animationName === "none"), "hidden toolbar stops both control and point flashes");
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  const motionRoot = page.locator(".categorized-library.library-motion-root");
  await motionRoot.evaluate(element => { element.style.transform = "translateX(200vw)"; });
  await page.waitForFunction(() => document.querySelector(".categorized-library.library-motion-root").dataset.libraryMotionPaused === "true");
  await motionRoot.evaluate(element => { element.style.removeProperty("transform"); });
  await page.waitForFunction(() => document.querySelector(".categorized-library.library-motion-root").dataset.libraryMotionPaused === "false");
  assert.equal(await page.evaluate(() => document.hasFocus()), false, "visibility recovery does not require acquiring document focus");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.mouse.move(0, 0); await card.hover();
  assert.equal(await card.evaluate(element => getComputedStyle(element, "::after").animationName), "none");
  await importButton.hover(); assert.ok(await importButton.evaluate(element => getComputedStyle(element).animationName === "none" && getComputedStyle(element, "::after").animationName === "none"));
  await page.emulateMedia({ forcedColors: "active" });
  assert.equal(await page.locator(".library-tactical-backdrop").first().evaluate(element => getComputedStyle(element).display), "none");
  assert.deepEqual(errors, []);
  console.log("PASS production tactical library: unchanged 1500/900/390 layout and CSS scope; neutral transparent controls, active points, filter and square sticky title; visible-unfocused control/point flashes and center-to-corner 400ms + delayed 160ms two flashes; media selection/video; safe background; keyboard, hidden/offscreen and reduced-motion/forced-color handling.");
} finally { await browser.close(); await server.close(); }
