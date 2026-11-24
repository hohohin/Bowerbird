import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const ffmpeg = process.env.BOWERBIRD_FFMPEG_BINARY || resolve("../../.tmp/video-integration/tools/local/ffmpeg.exe");
await mkdir(".tmp/video-theme", { recursive: true });
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=teal:s=240x320:d=1",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", ".tmp/video-theme/sample.mp4"], { windowsHide: true });
const server = await createServer({ cacheDir: ".tmp/video-theme/vite",
  optimizeDeps: { entries: ["scripts/fixtures/video-player-live/preview.html"] },
  server: { host: "127.0.0.1", port: 17978, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: "reduce" });
const player = page.getByRole("region", { name: "视频播放器" });

async function checkContrast(locator, label, minimum = 4.5) {
  const ratio = await locator.evaluate(element => {
    const background = getComputedStyle(element.closest(".video-player-controls")).backgroundColor;
    const foreground = getComputedStyle(element).color;
    const luminance = color => color.match(/\d+/g).slice(0, 3).reduce((sum, number, index) => {
      const value = Number(number) / 255;
      return sum + [0.2126, 0.7152, 0.0722][index] * (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    }, 0);
    const levels = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (levels[0] + .05) / (levels[1] + .05);
  });
  assert.ok(ratio >= minimum, `${label} contrast ${ratio.toFixed(2)} < ${minimum}`);
}

try {
  await page.goto(new URL("scripts/fixtures/video-player-live/preview.html?contrast", server.resolvedUrls.local[0]).href);
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
  await player.getByRole("button", { name: "导出帧" }).click();
  await page.getByRole("menuitem", { name: "添加该帧到画板" }).click();
  const saved = player.getByText("已添加到画板", { exact: true });
  await saved.waitFor();
  await player.locator("video").dispatchEvent("error");
  const error = player.getByRole("alert");
  await error.waitFor();
  for (const theme of ["dark", "light"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await checkContrast(player.locator(".video-player-time"), `${theme} time`);
    await checkContrast(player.getByRole("button", { name: "静音", exact: true }), `${theme} mute`, 3);
    await checkContrast(saved, `${theme} success`);
    await checkContrast(error, `${theme} error`);
  }
  console.log("PASS player control, success and error contrast in both themes");
} finally {
  await browser.close();
  await server.close();
}
