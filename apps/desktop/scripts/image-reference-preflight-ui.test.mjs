import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

// Synthetic IPC only: exercise the real library and both generation composers.
const server = await createServer({ configFile: false, root: process.cwd(),
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
async function load(second = "video") {
  await page.evaluate(second => {
    const refs = [window.mediaRefs.frame, window.mediaRefs[second]];
    window.dispatchEvent(new CustomEvent("bowerbird://board-load-prompt", { detail: {
      prompt: `@${refs[0].name}.png 拉远镜头，加入 @${refs[1].name}.${refs[1].ext}`,
      refs, referenceNodeIds: ["frame-node", null],
    } }));
  }, second);
}
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/canvas-reference/preview.html`);
  await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
  await page.evaluate(async () => {
    const { api } = await import("/src/lib/api.ts");
    api.dreaminaVideoModels = async () => [{ model_version: "seedance2.5", resolutions: ["720p"], min_duration: 4, max_duration: 30 }];
    const poster = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="green"/></svg>';
    window.mediaRefs = {
      frame: { id: "frame", name: "截帧", ext: "png", store_path: "/frame.png", thumb_path: poster, duration: 0, source: "video-frame" },
      video: { id: "video", name: "产品视频", ext: "mp4", store_path: "/product.mp4", thumb_path: poster, duration: 10.08 },
      product: { id: "product", name: "产品图片", ext: "png", store_path: "/product.png", thumb_path: poster, duration: 0 },
    };
    window.store.setState({ boardOpen: true, activeGenProvider: "jimeng", dreaminaHealth: { ok: true },
      assets: [...window.store.getState().assets, ...Object.values(window.mediaRefs)],
      cloudEntitlement: { plan: "pro", policy: { can_use_byo: true, max_parallel_jobs: 2 }, balances: { daily: 100 } },
    });
  });
  const dock = page.locator(".creation-dock");
  await dock.locator(".ProseMirror").click();
  await load();
  await dock.getByRole("alert").waitFor();
  assert.match(await dock.getByRole("alert").innerText(), /第 2 个参考「产品视频」是视频/);
  assert.equal(await dock.locator('[data-media-kind="video"]').innerText(), "视频");
  assert.equal(await dock.locator('[data-asset-id="frame"]').getAttribute("data-media-kind"), "image");
  assert.equal(await dock.getByRole("button", { name: "生成图像", exact: true }).isDisabled(), true);
  await dock.locator(".ProseMirror").press("Control+Enter");
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "codex_create_image").length), 0);
  await load("product");
  await dock.getByRole("alert").waitFor({ state: "detached" });
  assert.equal(await dock.getByRole("button", { name: "生成图像", exact: true }).isEnabled(), true);
  assert.deepEqual(await dock.locator(".ProseMirror [data-asset-id]").evaluateAll(nodes => nodes.map(node => node.dataset.assetId)), ["frame", "product"]);

  // The same invalid reference must remain usable in video multimodal mode.
  await load();
  await dock.getByRole("alert").waitFor();
  await dock.getByRole("combobox", { name: "生成媒体", exact: true }).selectOption("video");
  await dock.getByRole("combobox", { name: "视频生成模式", exact: true }).selectOption("multimodal2video");
  await dock.getByRole("alert").waitFor({ state: "detached" });
  assert.equal(await dock.locator('[data-media-kind="video"]').count(), 1, JSON.stringify({ errors, dom: await page.locator('body').innerText() }));

  await page.evaluate(() => {
    const job = { id: "test-job", projectId: "p", threadId: "t", provider: "jimeng", sessionId: "synthetic-session",
      running: false, streaming: "", refAssets: [], lastRefs: [], lastPrompt: "原图", media: "image",
      turns: [{ id: 1, prompt: "原图", images: [], provider: "jimeng" }] };
    window.store.setState({ genJobs: { [job.id]: job }, genJobOrder: [job.id], activeJobId: job.id,
      activeSessionKind: "generation", genPanelOpen: true, boardOpen: false, genEditing: null });
  });
  const inspector = page.locator('[data-project-inspector="generation"]');
  await inspector.getByRole("button", { name: /^继续对话/ }).click();
  const composer = inspector.locator('[data-generation-composer="inline"]');
  await composer.locator(".ProseMirror").click();
  await load();
  await composer.getByRole("alert").waitFor();
  assert.equal(await composer.getByRole("button", { name: "发送", exact: true }).isDisabled(), true);
  await load("product");
  await composer.getByRole("alert").waitFor({ state: "detached" });
  assert.equal(await composer.getByRole("button", { name: "发送", exact: true }).isEnabled(), true);

  await page.evaluate(async () => {
    const { mountReferenceLibrary } = await import("/scripts/fixtures/reference-media.tsx");
    mountReferenceLibrary(Object.values(window.mediaRefs));
  });
  const library = page.locator("#library-check");
  await library.locator('[aria-label="视频素材"]').waitFor();
  assert.equal(await library.locator('[data-asset-id="video"] [aria-label="视频素材"]').count(), 1);
  assert.equal(await library.locator('[data-asset-id="frame"] [aria-label="视频素材"]').count(), 0);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "codex_create_image").length), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: video poster labels, PNG frame identity, both image composers validate before submission, correction and video mode recover");
} finally {
  await browser.close();
  await server.close();
}
