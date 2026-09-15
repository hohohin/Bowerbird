import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1589, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:1589/scripts/fixtures/onboarding/preview.html");
  await page.getByRole("button", { name: "跳过入门引导", exact: true }).waitFor();
  const startup = await page.evaluate(async () => {
    const { loadCachedTheme, applyTheme } = await import("/src/lib/theme.ts");
    const initialScheme = getComputedStyle(document.documentElement).colorScheme;
    localStorage.removeItem("bowerbird.theme");
    const empty = loadCachedTheme();
    localStorage.setItem("bowerbird.theme", "invalid");
    const invalid = loadCachedTheme();
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error("storage unavailable"); };
    const unavailable = loadCachedTheme();
    Storage.prototype.getItem = original;
    applyTheme("dark");
    const savedDark = loadCachedTheme();
    applyTheme("light");
    return { initialScheme, empty, invalid, unavailable, savedDark, savedLight: loadCachedTheme(), theme: document.documentElement.dataset.theme };
  });
  assert.deepEqual(startup, { initialScheme: "light", empty: "light", invalid: "light", unavailable: "light", savedDark: "dark", savedLight: "light", theme: "light" });
  await page.getByRole("button", { name: "跳过入门引导", exact: true }).click();
  await page.getByRole("button", { name: "测试设置入口", exact: true }).click();
  await page.getByRole("radio", { name: "日间模式" }).waitFor();
  assert.equal(await page.getByRole("radio", { name: "日间模式" }).getAttribute("aria-checked"), "true");
  await mkdir(".tmp", { recursive: true });
  await page.screenshot({ path: ".tmp/theme-settings-light.png", animations: "disabled" });
  const settingsContrast = await page.evaluate(() => {
    const luminance = color => color.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const rgb = value => (value.match(/[\d.]+/g) || []).map(Number);
    const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
    return [...document.querySelectorAll(".app-modal *")].filter(el => el.checkVisibility() && !el.closest(":disabled") && [...el.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())).flatMap(el => {
      const ancestors = []; for (let node = el; node; node = node.parentElement) ancestors.unshift(node);
      let bg = [255, 255, 255];
      for (const node of ancestors) bg = over(rgb(getComputedStyle(node).backgroundColor), bg);
      const fg = over(rgb(getComputedStyle(el).color), bg);
      const levels = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      const ratio = (levels[0] + .05) / (levels[1] + .05);
      return ratio < 4.5 ? [{ text: el.textContent.slice(0, 40), ratio: +ratio.toFixed(2), class: el.className }] : [];
    });
  });
  assert.deepEqual(settingsContrast, [], "visible settings text must be readable in the day theme");
  await page.getByRole("radio", { name: "夜间模式" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(await page.getByRole("radio", { name: "夜间模式" }).getAttribute("aria-checked"), "true");
  await page.screenshot({ path: ".tmp/theme-settings-dark.png", animations: "disabled" });
  await page.getByRole("radio", { name: "日间模式" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.screenshot({ path: ".tmp/theme-canvas-light.png", animations: "disabled" });

  // Use the production stylesheet to exercise status text, controls, and media exceptions.
  const failures = await page.evaluate(() => {
    document.getElementById("root").style.display = "none";
    const cases = [
      ["辅助说明", "bg-panel2", "text-faint"],
      ["蓝色按钮", "", "bg-accent text-black"],
      ["错误信息", "bg-red-500/15", "text-red-300"],
      ["失败状态", "bg-panel", "text-red-400"],
      ["失败详情", "bg-red-500/15", "text-red-200/90"],
      ["成功状态", "bg-panel", "text-green-400"],
      ["Agent 确认", "bg-amber-400/8", "text-amber-100"],
      ["Agent 提醒", "bg-amber-400/8", "text-amber-200"],
      ["Agent 等待", "bg-panel", "text-amber-300"],
      ["完成标签", "bg-panel", "text-lime"],
      ["行内警告", "bg-panel", "app-inline-status is-warning"],
      ["行内成功", "bg-panel", "app-inline-status is-success"],
      ["行内错误", "bg-panel", "app-inline-status is-error"],
      ["删除菜单", "app-context-menu", "app-context-item is-danger"],
      ["危险按钮", "app-modal", "app-modal-button is-danger"],
      ["保存失败", "canvas-board-toolbar bg-panel", "canvas-save-error"],
      ["标注错误", "image-annotator bg-black/90", "text-red-300"],
      ["标注提示", "image-annotator bg-black/90", "text-white/60"],
    ];
    const rgb = value => (value.match(/[\d.]+/g) || []).map(Number);
    const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
    const luminance = color => color.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const failures = [];
    for (const [label, parentClass, textClass] of cases) {
      const parent = document.createElement("div"); parent.className = parentClass;
      const el = document.createElement("span"); el.className = textClass; el.textContent = label;
      parent.append(el); document.body.append(parent);
      const ancestors = []; for (let node = el; node; node = node.parentElement) ancestors.unshift(node);
      let bg = [255, 255, 255];
      for (const node of ancestors) bg = over(rgb(getComputedStyle(node).backgroundColor), bg);
      const fg = over(rgb(getComputedStyle(el).color), bg);
      const levels = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      const ratio = (levels[0] + .05) / (levels[1] + .05);
      if (ratio < 4.5) failures.push({ label, ratio: +ratio.toFixed(2), fg, bg });
      parent.remove();
    }
    return failures;
  });
  assert.deepEqual(failures, [], "day theme text contrast must be at least 4.5:1");
  assert.deepEqual(errors, []);
  console.log("PASS: light startup under dark OS, cache fallback, saved choices, settings selection, 19 text/background contrast cases and dark media exceptions");
} finally {
  await browser.close();
  await server.close();
}
