import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

// Exercise the production panel through the toolbar, using the closed IPC fixture.
const server = await createServer({ server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
const panel = page.locator(".project-manager-panel");
try {
  await mkdir(".tmp/project-manager", { recursive: true });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/project-drop/preview.html?layout`);
  await page.getByRole("button", { name: "我的项目", exact: true }).waitFor();
  const images = await Promise.all(Array.from({ length: 6 }, async (_, i) =>
    "data:image/webp;base64," + (await readFile(`src-tauri/resources/samples/preset-${String(i + 1).padStart(2, "0")}.webp`)).toString("base64")));
  await page.evaluate(images => {
    const now = Math.floor(Date.now() / 1000);
    const names = ["山野护肤 · 品牌视觉", "秋日系列 · 电商海报", "山间徒步 · 视频分镜", "栖木咖啡 · 包装探索", "理想居所 · 空间灵感", "未命名项目"];
    const projects = names.map((name, i) => ({ id: `design-${i}`, name, kind: "blank", workspace_path: `blank:design-${i}`, created_at: now - 86400, updated_at: now - i * 3600, asset_count: i === 5 ? 0 : 12 + i }));
    const assets = images.map((src, i) => ({ id: `image-${i}`, name: `素材 ${i}`, thumb_path: src, store_path: src, width: 600, height: 400 }));
    const memberships = projects.slice(0, 5).flatMap((p, i) => assets.slice(0, 6 - i).map(a => ({ projectId: p.id, assetId: a.id })));
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "list_library_view") {
        if (window.failProjectCovers) throw new Error("封面加载失败");
        return { assets, total: assets.length, memberships };
      }
      return invoke(command, args);
    };
    window.store.setState({ projects: [...projects, { ...projects[0], id: "draft", provisional: true }, { ...projects[0], id: "archived", archived_at: now }],
      activeProjectId: "design-0", projectsThumbnailWidth: 200,
      enterProject: async id => { window.openedProject = id; } });
  }, images);
  await page.getByRole("button", { name: "我的项目", exact: true }).click();
  await panel.locator(".project-manager-card img").first().waitFor();
  assert.equal(await panel.locator(".project-manager-card").count(), 6);
  assert.equal(await panel.locator(".project-manager-count").textContent(), "06");
  assert.equal(await panel.locator(".project-manager-count").getAttribute("aria-label"), "6 个项目");
  assert.equal(await panel.locator(".project-manager-meta").first().textContent(), "12 个素材·刚刚更新");
  const compactPanel = await panel.locator('.app-modal').boundingBox();
  const compactColumns = await panel.locator('.project-manager-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
    await page.setViewportSize(viewport);
    const bounds = await panel.locator('.app-modal').boundingBox();
    assert.equal(bounds.width, viewport.width - 64);
    assert.equal(bounds.height, viewport.height - 80);
    assert.ok(bounds.width > compactPanel.width && bounds.height > compactPanel.height, 'panel grows in both dimensions with the window');
    assert.ok(await panel.locator('.project-manager-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length) > compactColumns, 'wider windows show more project columns');
    const footer = await panel.locator('.app-modal-footer').boundingBox();
    assert.ok(footer.y + footer.height <= bounds.y + bounds.height + 1, 'footer remains inside the resized panel');
  }
  await page.screenshot({ path: '.tmp/project-manager/wide.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await panel.locator(".app-modal").evaluate(el => getComputedStyle(el).fontFamily), '"Segoe UI", "Microsoft YaHei", sans-serif');
  assert.equal(await panel.locator(".project-manager-empty-cover").textContent(), "开始你的创作");
  const covers = await panel.locator(".library-project-mosaic").evaluateAll(nodes => nodes.map(node => {
    return node.offsetHeight;
  }));
  assert.ok(covers.every(height => height === 150));
  assert.equal(await panel.locator('.library-project-mosaic').evaluateAll(nodes => nodes.every(node => {
    const style = getComputedStyle(node);
    return style.marginLeft === '12px' && style.marginRight === '12px';
  })), true, 'project covers retain 12px of space on both sides');
  await panel.locator('.project-manager-card img').evaluateAll(images => Promise.all(images.map(img => img.decode())));
  assert.equal(await panel.locator('.project-manager-card img').evaluateAll(images => images.every(img => {
    const image = img.getBoundingClientRect(), cell = img.parentElement.getBoundingClientRect();
    return ['x', 'y', 'width', 'height'].every(key => Math.abs(image[key] - cell[key]) < .1) && getComputedStyle(img).objectFit === 'cover';
  })), true, 'images fill their cells without intrinsic grid overflow or displaced cropping');
  const card = panel.locator(".project-manager-card").nth(1);
  const slot = panel.locator('.project-manager-slot').nth(1);
  const beforeHover = await slot.boundingBox();
  await card.hover({ position: { x: 50, y: 50 } }); await page.waitForTimeout(350);
  const depth = await card.evaluate(el => ({ transform: getComputedStyle(el).transform, cover: getComputedStyle(el.querySelector('.library-project-mosaic')).transform,
    title: getComputedStyle(el.querySelector('strong')).color, ink: getComputedStyle(el.closest('.app-modal')).color,
    edge: getComputedStyle(el.querySelector('.library-project-enter'), '::after').content }));
  assert.match(depth.transform, /matrix3d/); assert.match(depth.cover, /matrix3d/);
  assert.equal(depth.title, depth.ink); assert.equal(depth.edge, 'none');
  await page.mouse.move(10, 10); await page.waitForTimeout(350);
  assert.deepEqual(await slot.boundingBox(), beforeHover, 'depth does not move grid slots');
  const current = panel.locator('.project-manager-card[data-active="true"]');
  assert.ok((await current.boundingBox()).y < (await panel.locator('.project-manager-slot').first().boundingBox()).y - 4, 'current project stays lifted');
  const heading = await panel.locator('.project-manager-section').boundingBox();
  assert.ok((await card.boundingBox()).y > heading.y + heading.height, 'lifted card clears the section heading');
  assert.equal(await panel.getByRole('button', { name: '打开项目 山野护肤 · 品牌视觉', exact: true }).getAttribute('aria-current'), 'true');
  const signal = panel.locator('.pm-signal').first();
  const signalValues = await signal.evaluate(el => {
    const animation = el.getAnimations()[0]; animation.pause();
    return animation.effect.getKeyframes().map(frame => { animation.currentTime = frame.offset * 7180; return Number(getComputedStyle(el).opacity); });
  });
  assert.ok(Math.max(...signalValues) - Math.min(...signalValues) > .3, 'background signals actually flicker');
  assert.equal(await panel.locator('.project-manager-ambient').evaluate(el => getComputedStyle(el).zIndex), '-1');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('.project-manager-ambient').dataset.paused === 'true');
  assert.equal(await signal.evaluate(el => el.getAnimations()[0].playState), 'paused');
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('.project-manager-ambient').dataset.paused === 'false');
  await panel.getByRole("textbox", { name: "搜索项目" }).fill("咖啡");
  assert.equal(await panel.locator(".project-manager-card").count(), 1);
  await panel.getByRole("textbox", { name: "搜索项目" }).fill("找不到");
  await panel.getByText("没有匹配的项目").waitFor();
  await panel.getByRole("textbox", { name: "搜索项目" }).fill("");
  await panel.getByRole("combobox", { name: "项目排序" }).selectOption("name");
  const names = await panel.locator(".library-project-folder-title strong").allTextContents();
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "zh-CN")));
  await panel.getByRole("combobox", { name: "项目排序" }).selectOption("recent");
  const size = panel.getByRole("slider", { name: "项目卡片大小", exact: true });
  await size.fill("0");
  const small = await panel.locator(".project-manager-card").first().boundingBox();
  await size.fill("100");
  const large = await panel.locator(".project-manager-card").first().boundingBox();
  assert.ok(large.width > small.width * 1.4);
  assert.equal(await page.evaluate(() => localStorage.getItem("bowerbird.projectsThumbnailWidth")), "320");
  await size.focus(); await size.press("ArrowLeft");
  assert.equal(await size.inputValue(), "99");
  await size.fill("50");
  assert.equal(await size.evaluate(el => el.style.getPropertyValue("--size-fill")), "50%");
  const pinch = await panel.locator(".project-manager-gallery").evaluate(el => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -10, ctrlKey: true });
    el.dispatchEvent(event); return event.defaultPrevented;
  });
  assert.equal(pinch, true);
  assert.ok(Number(await size.inputValue()) > 50);
  await size.fill("46");
  await panel.getByRole("button", { name: "列表视图" }).click();
  const rows = await panel.locator(".project-manager-card").evaluateAll(nodes => nodes.map(n => n.closest('.project-manager-slot').getBoundingClientRect().left));
  assert.ok(rows.every(left => Math.abs(left - rows[0]) < 1));
  await panel.getByRole("button", { name: "网格视图" }).click();
  assert.equal(await panel.locator('button button').count(), 0, 'card actions are independent buttons');
  const arrowsAtCorner = () => panel.locator('.project-manager-open').evaluateAll(buttons => buttons.every(button =>
    getComputedStyle(button).position === 'absolute' && button.offsetTop === 2 && Math.abs(button.offsetLeft + button.offsetWidth + 4 - button.offsetParent.clientWidth) < 1));
  assert.equal(await arrowsAtCorner(), true, 'entry arrows occupy the top-right corner');
  const titleRow = panel.locator('.library-project-folder-title').first();
  assert.equal(await titleRow.getByRole('button', { name: '项目操作 山野护肤 · 品牌视觉', exact: true }).count(), 1);
  const selectedBeforeMenu = await panel.locator('.project-manager-activate[aria-current="true"]').getAttribute('aria-label');
  await panel.getByRole("button", { name: "项目操作 山野护肤 · 品牌视觉", exact: true }).click();
  assert.equal(await page.evaluate(() => window.store.getState().projectContextMenu.projectId), "design-0");
  assert.equal(await panel.locator('.project-manager-activate[aria-current="true"]').getAttribute('aria-label'), selectedBeforeMenu, 'menu does not also select the card');
  assert.equal(await page.evaluate(() => window.openedProject), undefined, 'menu does not open the project');
  await page.keyboard.press("Escape");
  assert.equal(await panel.count(), 1, "Escape does not close the manager while a project menu owns focus");
  await page.evaluate(() => window.store.setState({ projectContextMenu: null }));
  await panel.locator('.project-manager-card').first().click({ button: 'right' });
  assert.equal(await page.evaluate(() => window.store.getState().projectContextMenu.projectId), 'design-0', 'right click and title menu use the same project menu');
  await page.evaluate(() => window.store.setState({ projectContextMenu: null }));
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.mouse.move(10, 10);
    await page.waitForTimeout(300);
    const createColors = await panel.getByRole('button', { name: '新建项目', exact: true }).evaluate(el => ({ color: getComputedStyle(el).color, ink: getComputedStyle(el.closest('.app-modal')).color, background: getComputedStyle(el).backgroundColor }));
    assert.equal(createColors.color, createColors.ink, 'creation button uses neutral text in both themes');
    assert.equal(await panel.locator('.app-modal').evaluate(el => getComputedStyle(el).backgroundColor.endsWith('0.88)')), true);
    assert.equal(await panel.locator('.app-modal-title').evaluate(el => getComputedStyle(el).fontSize), '26px');
    await panel.locator(".project-manager-card img").evaluateAll(images => Promise.all(images.map(img => img.decode())));
    await page.screenshot({ path: `.tmp/project-manager/${theme}.png` });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => document.querySelector('.pm-signal').getAnimations().length === 0);
  assert.equal(await signal.evaluate(el => el.getAnimations().length), 0);
  await card.hover();
  assert.equal(await card.evaluate(el => getComputedStyle(el).transform), 'none');
  for (const width of [736, 375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bounds = await panel.locator(".app-modal").evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right }));
    assert.ok(bounds.scroll <= bounds.width + 1 && bounds.left >= 0 && bounds.right <= width, JSON.stringify(bounds));
    await panel.getByRole("button", { name: "列表视图" }).click();
    assert.equal(await arrowsAtCorner(), true, 'entry arrows stay top-right in narrow list view');
    assert.equal(await panel.locator(".project-manager-grid").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await panel.getByRole("button", { name: "网格视图" }).click();
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: ".tmp/project-manager/narrow.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel.getByRole("button", { name: "打开项目 山野护肤 · 品牌视觉", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.openedProject), "design-0");
  await page.getByRole("button", { name: "我的项目", exact: true }).click();
  assert.equal(await size.inputValue(), "46", "size survives closing and reopening");
  await page.evaluate(() => window.openedProject = null);
  const directOpen = panel.getByRole('button', { name: '打开项目 理想居所 · 空间灵感', exact: true });
  assert.equal(await panel.getByRole('button', { name: /^进入项目/ }).count(), 0, 'arrow is decorative, not a second action');
  const directBounds = await directOpen.boundingBox();
  await directOpen.click({ position: { x: directBounds.width - 16, y: 15 } });
  await panel.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.openedProject), 'design-4', 'arrow area activates the same full-card entry');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  const keyboardProject = panel.getByRole('button', { name: '打开项目 秋日系列 · 电商海报', exact: true });
  await keyboardProject.focus(); await keyboardProject.press('Space');

  await panel.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.openedProject), 'design-1');
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await panel.getByRole("button", { name: "新建项目", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.createdProjects), 1);
  await page.evaluate(() => window.failProjectCovers = true);
  await page.getByRole("button", { name: "我的项目", exact: true }).click();
  await panel.getByRole("alert").waitFor();
  await page.evaluate(() => window.failProjectCovers = false);
  await panel.getByRole("button", { name: "重试" }).click();
  await panel.locator(".project-manager-card img").first().waitFor();
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("button", { name: "我的项目", exact: true }).evaluate(el => document.activeElement === el), true);
  // Use a closed IPC stub to verify dropping onto the redesigned card still targets
  // its project, without opening it or touching files.
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
  await page.evaluate(async () => {
    const { setDragAssets } = await import('/src/lib/dragPayload.ts');
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'add_assets_to_project') { window.managerDrop = args; return args.assetIds.length; }
      return invoke(command, args);
    };
    setDragAssets(['image-1']);
  });
  const dropTarget = panel.locator('[data-project-drop-id="design-1"]');
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await dropTarget.dispatchEvent('dragover', { dataTransfer: transfer });
  assert.equal(await dropTarget.getAttribute('data-project-drop-state'), 'over');
  await dropTarget.dispatchEvent('drop', { dataTransfer: transfer });
  await page.waitForFunction(() => window.managerDrop);
  assert.deepEqual(await page.evaluate(() => window.managerDrop), { projectId: 'design-1', assetIds: ['image-1'] });
  assert.equal(await panel.isVisible(), true);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log("PASS: project manager search/sort/views, 3D current/hover and single-click entry, cover layouts, empty/retry, persistent slider/keyboard/pinch, menu guard, enter/create/close, light/dark and 320px layout.");
} finally { await browser.close(); await server.close(); }
