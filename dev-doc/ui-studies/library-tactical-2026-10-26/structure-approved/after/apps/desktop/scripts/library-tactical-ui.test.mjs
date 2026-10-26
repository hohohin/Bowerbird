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
const geometrySelectors = [".app-topbar", ".catalog-sidebar", ".catalog-alphabet", ".catalog-gallery", ".catalog-scroller", ".library-view-switch", ".library-media-switch", ".thumbnail-size-slider", ".catalog-section-heading", ".folder-media-card"];
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

  // Toolbar buttons and title contents changed intentionally; the shell and gallery geometry must not.
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
    assert.ok(await page.locator(".library-projects-trigger").evaluate(element => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && element.scrollWidth <= element.clientWidth;
    }), `${width}px project entry remains within the toolbar without clipped contents`);
    assert.ok(await page.locator(".app-topbar").evaluate(element => {
      const leading = element.querySelector(".app-topbar-leading").getBoundingClientRect();
      const account = element.querySelector(".topbar-account-trigger").getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return leading.left >= box.left && leading.right <= account.left && account.right <= box.right && leading.height <= box.height && account.height <= box.height;
    }), `${width}px action and account groups fit without overlap`);
    const importTrigger = page.locator(".app-topbar-import > button");
    await importTrigger.click();
    assert.ok(await page.locator('.app-topbar-import [role="menu"]').evaluate(element => {
      const box = element.getBoundingClientRect(), header = element.closest(".app-topbar").getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, Math.min(box.bottom - 4, innerHeight - 4));
      return box.bottom > header.bottom && box.left >= 0 && box.right <= innerWidth && element.contains(hit);
    }), `${width}px import popover extends beyond the header without clipping`);
    await importTrigger.click();
  }
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.waitForTimeout(350);
  assert.equal(await page.locator('.structure-study-tools,.structure-preview-menu').count(), 0, "preview tools are not shipped in the production toolbar");
  assert.equal(await page.locator('.library-toolbar-context').count(), 1);
  assert.ok(await page.locator('.library-sidebar-meter').evaluate(element => {
    const box = element.getBoundingClientRect(), sidebar = element.closest('.catalog-sidebar').getBoundingClientRect();
    return element.getAttribute('aria-hidden') === 'true' && getComputedStyle(element).pointerEvents === 'none' && box.left >= sidebar.right;
  }), 'sidebar meter remains outside the interactive sidebar and ignores pointer input');
  const firstTitle = page.locator('[data-tag-section="a"] .catalog-section-title');
  assert.equal(await firstTitle.getAttribute('data-library-count'), '16 项', 'heading exposes the actual total, not the currently rendered card count');
  await page.getByRole('button', { name: '只看生成图', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-tag-section="a"] .catalog-section-title')?.getAttribute('data-library-count') === '04 项');
  assert.equal(await page.locator('[data-tag-section="z"] .catalog-section-title').getAttribute('data-library-count'), '03 项', 'each tag count follows the generated filter');
  await page.getByRole('button', { name: '只看生成图', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-tag-section="a"] .catalog-section-title')?.getAttribute('data-library-count') === '16 项');

  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    const controls = await page.evaluate(() => [".library-view-switch", ".library-media-switch", '.library-filter-trigger[aria-label="文件浏览器"]', ".thumbnail-size-slider"].map(selector => {
      const element = document.querySelector(selector), style = getComputedStyle(element);
      return { selector, radius: style.borderRadius, image: style.backgroundImage, alpha: Number(style.backgroundColor.match(/[\d.]+/g).at(-1)), blur: style.backdropFilter, point: getComputedStyle(element, "::after").content };
    }));
    const expectedAlpha = theme === "light" ? .776 : .808;
    assert.ok(controls.every(control => control.radius === "0px" && control.image === "none" && control.blur === "none" && Math.abs(control.alpha - expectedAlpha) < .005 && control.point === "none"), `${theme}: ${JSON.stringify(controls)}`);
    const surfaces = await page.evaluate(() => ({
      floor: getComputedStyle(document.querySelector('.categorized-library')).backgroundColor,
      header: getComputedStyle(document.querySelector('.app-topbar')).backgroundColor,
      import: getComputedStyle(document.querySelector('.app-topbar-import > button')).backgroundColor,
      tagManager: getComputedStyle(document.querySelector('.catalog-sidebar-heading button')).backgroundColor,
      buttonHeight: getComputedStyle(document.querySelector('.app-topbar-import > button')).height,
      accountHeight: getComputedStyle(document.querySelector('.topbar-account-trigger')).height,
    }));
    assert.deepEqual(surfaces, {
      floor: theme === 'light' ? 'rgb(238, 237, 233)' : 'rgb(25, 31, 33)',
      header: theme === 'light' ? 'rgb(245, 244, 240)' : 'rgb(32, 37, 40)',
      import: 'rgba(0, 0, 0, 0)', tagManager: 'rgba(0, 0, 0, 0)', buttonHeight: '32px', accountHeight: '40px',
    }, `${theme}: project-panel palette and restrained controls`);
    const activeTab = page.getByRole("tab", { name: "标签分类", exact: true });
    const point = await activeTab.evaluate(element => { const style = getComputedStyle(element, "::after"); return { content: style.content, width: style.width, height: style.height, right: style.right, bottom: style.bottom }; });
    assert.deepEqual(point, { content: '""', width: "2px", height: "2px", right: "3px", bottom: "3px" }, "only highlighted controls expose the lower-right point");
    const projectEntry = page.locator(".library-projects-trigger");
    assert.equal(await projectEntry.getAttribute("aria-haspopup"), "dialog");
    assert.equal(await projectEntry.getAttribute("aria-expanded"), "false");
    assert.equal(await projectEntry.locator("svg").count(), 1, "project entry uses one plain icon without an ending arrow");
    assert.deepEqual(await projectEntry.locator("svg").evaluate(element => { const style = getComputedStyle(element); return [style.width, style.height, style.backgroundColor, style.padding]; }), ['15px', '15px', 'rgba(0, 0, 0, 0)', '0px'], "project icon has no separate tile");
    assert.equal(await projectEntry.evaluate(element => getComputedStyle(element).backgroundColor), theme === 'light' ? 'rgba(41, 44, 50, 0.09)' : 'rgba(228, 230, 235, 0.12)', `${theme} project entry has a low-contrast background`);
    await projectEntry.hover();
    await page.waitForTimeout(200);
    assert.equal(await projectEntry.evaluate(element => getComputedStyle(element).backgroundColor), theme === 'light' ? 'rgba(41, 44, 50, 0.14)' : 'rgba(228, 230, 235, 0.18)', `${theme} project hover keeps the neutral background`);
    assert.equal(await projectEntry.evaluate(element => getComputedStyle(element).boxShadow), "none", `${theme} project hover has no legacy shadow`);
    await page.mouse.down();
    assert.ok(await projectEntry.evaluate(element => element.matches(":active") && getComputedStyle(element).boxShadow === "none"), `${theme} project pressed state has no legacy shadow`);
    await page.mouse.move(0, 0); await page.mouse.up();
    const regularControl = page.locator(".app-topbar-import > button");
    await regularControl.hover(); await page.waitForTimeout(200);
    const hoverSurface = await regularControl.evaluate(element => {
      const style = getComputedStyle(element), channels = style.backgroundColor.match(/[\d.]+/g);
      return { color: style.backgroundColor, alpha: channels.length === 4 ? Number(channels[3]) : 1, border: style.borderTopColor };
    });
    assert.ok(Math.abs(hoverSurface.alpha - (theme === "light" ? .035 : .065)) < .005, `${theme} toolbar hover remains subtle: ${JSON.stringify(hoverSurface)}`);
    assert.equal(hoverSurface.border, "rgba(0, 0, 0, 0)", "hover does not restore the legacy button border");
    await page.mouse.move(0, 0); await page.waitForTimeout(200);
    await page.screenshot({ path: `${output}/${theme}.png` });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });

  // Hover/focus belongs to one tab; the shared selection thumb must not flash for its siblings.
  const viewSwitch = page.getByRole("tablist", { name: "素材视图切换条" });
  const tabMotion = () => viewSwitch.evaluate(element => ({
    tabs: [...element.querySelectorAll('button')].map(button => ({
      selected: button.getAttribute('aria-selected') === 'true',
      interacting: button.matches(':hover, :focus-visible'),
      animation: getComputedStyle(button).animationName,
    })),
    thumb: getComputedStyle(element.querySelector('.library-view-switch-thumb')).animationName,
    transition: getComputedStyle(element.querySelector('.library-view-switch-thumb')).transitionProperty,
  }));
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const tab of await viewSwitch.getByRole("tab").all()) {
      await page.mouse.move(0, 0);
      await tab.hover();
      const motion = await tabMotion();
      assert.equal(motion.tabs.filter(item => item.interacting).length, 1);
      assert.ok(motion.tabs.every(item => item.animation === (item.interacting ? "library-tactical-control-contact" : "none")), `${theme}: only the hovered tab flashes`);
      assert.equal(motion.thumb, motion.tabs.some(item => item.selected && item.interacting) ? "library-tactical-control-contact" : "none", `${theme}: unhovered selected tab remains steady`);
      assert.equal(motion.transition, "transform", "selection thumb keeps its sliding transition");
    }
  }
  await page.mouse.move(0, 0);
  await viewSwitch.getByRole("tab", { name: "全部", exact: true }).focus();
  await page.keyboard.press("Shift");
  assert.equal((await tabMotion()).thumb, "none", "focus on an unselected tab does not flash the selected thumb");
  await viewSwitch.getByRole("tab", { name: "标签分类", exact: true }).focus();
  assert.equal((await tabMotion()).thumb, "library-tactical-control-contact", "focus on the selected tab still flashes its thumb");
  await viewSwitch.getByRole("tab", { name: "全部", exact: true }).click();
  assert.equal(await viewSwitch.getByRole("tab", { name: "全部", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await viewSwitch.evaluate(element => element.style.getPropertyValue("--switch-index")), "0");
  await viewSwitch.getByRole("tab", { name: "标签分类", exact: true }).click();
  assert.equal(await viewSwitch.getByRole("tab", { name: "标签分类", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await viewSwitch.evaluate(element => element.style.getPropertyValue("--switch-index")), "1");
  await viewSwitch.getByRole("tab", { name: "标签分类", exact: true }).evaluate(element => element.blur());
  await page.mouse.move(0, 0);
  await page.locator('[data-asset-id="tactical-0"]').waitFor();
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
  assert.ok(Math.abs(await page.getByRole("dialog", { name: "颜色筛选", exact: true }).evaluate(element => Number(getComputedStyle(element).backgroundColor.match(/[\d.]+/g).at(-1))) - .936) < .005, "expanded surface transparency decreases by 20%");
  const selectedColor = await page.locator(".library-view-switch-thumb").evaluate(element => getComputedStyle(element).backgroundColor);
  assert.equal(await colors.evaluate(element => getComputedStyle(element).backgroundColor), selectedColor, "open filter retains active paint while hovered");
  assert.ok(await page.locator(".library-filter-colors button").evaluateAll(elements => elements.every(element => getComputedStyle(element).borderRadius === "0px")));
  await page.getByRole("button", { name: "红", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => [...document.querySelectorAll(".folder-media-card")].length > 0 && [...document.querySelectorAll(".folder-media-card")].every(element => Number(element.dataset.assetId.split("-")[1]) % 2 === 1));
  assert.equal(await firstTitle.getAttribute('data-library-count'), '08 项', 'heading count follows the color filter');
  assert.equal(await colors.getAttribute("data-active"), "true");
  await colors.click(); await page.getByRole("button", { name: "清除颜色筛选", exact: true }).click(); await page.keyboard.press("Escape");
  await page.locator('[data-asset-id="tactical-0"]').waitFor();
  assert.equal(await firstTitle.getAttribute('data-library-count'), '16 项', 'clearing color restores the actual total');

  await card.hover();
  const motion = await card.evaluate(element => {
    const animations = element.getAnimations({ subtree: true });
    const clockwise = animations.find(item => item.animationName === "library-tactical-card-clockwise");
    const flash = animations.find(item => item.animationName === "library-tactical-card-contact");
    if (!clockwise || !flash) return null;
    const running = clockwise.playState === "running" && flash.playState === "running";
    clockwise.pause(); flash.pause(); flash.currentTime = 0;
    clockwise.currentTime = 0; const start = getComputedStyle(element, "::after").backgroundPosition;
    clockwise.currentTime = 40; const appeared = getComputedStyle(element, "::after").backgroundPosition;
    clockwise.currentTime = 200; const middle = getComputedStyle(element, "::after").backgroundPosition;
    clockwise.currentTime = 400; const end = getComputedStyle(element, "::after").backgroundPosition;
    clockwise.currentTime = 900; const held = getComputedStyle(element, "::after").backgroundPosition;
    clockwise.finish();
    const opacity = [350, 410, 450, 490, 530].map(time => { flash.currentTime = time; return Number(getComputedStyle(element, "::after").opacity); });
    flash.finish();
    const marker = getComputedStyle(element, "::after"), preview = element.querySelector(".folder-media-preview");
    return { running, start, appeared, middle, end, held, opacity, duration: clockwise.effect.getTiming().duration, flash: flash.effect.getTiming(), size: marker.backgroundSize,
      inset: marker.inset, pointer: marker.pointerEvents, overflow: getComputedStyle(element).overflow, previewOverflow: getComputedStyle(preview).overflow,
      imageCorners: preview.offsetLeft === 0 && preview.offsetTop === 0 && preview.offsetWidth === element.clientWidth && preview.offsetHeight === element.clientHeight };
  });
  assert.ok(motion, "hover starts both position and delayed flicker animations");
  assert.ok(motion.running, "visible unfocused page runs clockwise corner motion and delayed flashes");
  assert.equal(motion.duration, 400); assert.equal(motion.flash.duration, 160); assert.equal(motion.flash.delay, 400);
  assert.equal(motion.start, "0% 0%, 100% 0%, 100% 100%, 0% 100%");
  assert.equal(motion.appeared, motion.start, "markers first appear at all four corners before moving");
  assert.equal(motion.end, "100% 0%, 100% 100%, 0% 100%, 0% 0%");
  assert.equal(motion.held, motion.end, "markers remain at their next clockwise vertices after 400ms");
  const midpoints = motion.middle.split(",").map(point => point.trim().split(/\s+/).map(parseFloat));
  assert.ok(midpoints[0][0] > 0 && midpoints[0][0] < 100 && midpoints[0][1] === 0, "top-left marker travels along the top edge");
  assert.ok(midpoints[1][0] === 100 && midpoints[1][1] > 0 && midpoints[1][1] < 100, "top-right marker travels along the right edge");
  assert.ok(midpoints[2][0] > 0 && midpoints[2][0] < 100 && midpoints[2][1] === 100, "bottom-right marker travels along the bottom edge");
  assert.ok(midpoints[3][0] === 0 && midpoints[3][1] > 0 && midpoints[3][1] < 100, "bottom-left marker travels along the left edge");
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
  const mediaSession = await page.context().newCDPSession(page);
  await mediaSession.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    assert.equal(await page.locator('.library-view-switch').evaluate(element => getComputedStyle(element).backgroundColor), theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(49, 57, 59)', `${theme}: reduced transparency uses an opaque surface`);
  }
  await mediaSession.detach();
  await page.emulateMedia({ forcedColors: "active" });
  assert.equal(await page.locator(".library-tactical-backdrop").first().evaluate(element => getComputedStyle(element).display), "none");
  assert.deepEqual(errors, []);
  console.log("PASS production tactical library: unchanged 1500/900/390 shell/gallery and CSS scope; unclipped import menus; neutral header groups and low-contrast project entry; real filtered tag counts and safe sidebar marks; isolated tab flashes; visible-unfocused control/point flashes and 400ms clockwise motion + 160ms two flashes; media selection/video; keyboard, hidden/offscreen, reduced-motion/transparency and forced colors.");
} finally { await browser.close(); await server.close(); }
