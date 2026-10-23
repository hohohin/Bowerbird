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
  assert.equal(await panel.locator(".project-manager-count").textContent(), "6 个项目");
  assert.equal(await panel.locator(".project-manager-meta").first().textContent(), "12 个素材·刚刚更新");
  assert.ok((await panel.locator(".app-modal").boundingBox()).width > 1250);
  assert.equal(await panel.locator(".project-manager-empty-cover").textContent(), "开始你的创作");
  const covers = await panel.locator(".library-project-mosaic").evaluateAll(nodes => nodes.map(node => {
    const r = node.getBoundingClientRect(); return r.width / r.height;
  }));
  assert.ok(covers.every(ratio => Math.abs(ratio - 1.6) < .02));
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
  const rows = await panel.locator(".project-manager-card").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().left));
  assert.ok(rows.every(left => Math.abs(left - rows[0]) < 1));
  await panel.getByRole("button", { name: "网格视图" }).click();
  await panel.getByRole("button", { name: "项目操作 山野护肤 · 品牌视觉", exact: true }).click();
  assert.equal(await page.evaluate(() => window.store.getState().projectContextMenu.projectId), "design-0");
  await page.keyboard.press("Escape");
  assert.equal(await panel.count(), 1, "Escape does not close the manager while a project menu owns focus");
  await page.evaluate(() => window.store.setState({ projectContextMenu: null }));
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.mouse.move(10, 10);
    await page.waitForTimeout(300);
    await panel.locator(".project-manager-card img").evaluateAll(images => Promise.all(images.map(img => img.decode())));
    await page.screenshot({ path: `.tmp/project-manager/${theme}.png` });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [736, 375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bounds = await panel.locator(".app-modal").evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right }));
    assert.ok(bounds.scroll <= bounds.width + 1 && bounds.left >= 0 && bounds.right <= width, JSON.stringify(bounds));
    await panel.getByRole("button", { name: "列表视图" }).click();
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
  assert.deepEqual(errors, []);
  console.log("PASS: project manager search/sort/views, cover layouts, empty/retry, persistent slider/keyboard/pinch, menu guard, enter/create/close, light/dark and 320px layout.");
} finally { await browser.close(); await server.close(); }
