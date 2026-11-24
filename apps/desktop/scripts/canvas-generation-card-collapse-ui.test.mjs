import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
import { startBrowserDrag, finishBrowserDrag } from "./fixtures/explorer/native-drag.mjs";

const entry = "scripts/fixtures/canvas-reference/preview.html";
const native = process.argv.includes("--native");
const runtime = native ? await import("./fixtures/canvas-interaction-performance/webview2.mjs") : null;
const ipc = runtime?.isolatedCanvasIpc();
const evidence = native ? ".tmp/canvas-generation-card-collapse/native" : ".tmp/canvas-generation-card-collapse";
const server = await createServer({
  cacheDir: `${evidence}/vite`,
  optimizeDeps: { entries: [entry], esbuildOptions: ipc?.esbuildOptions },
  plugins: ipc ? [ipc.plugin] : [],
  server: { host: "127.0.0.1", port: native ? 17974 : 17973, strictPort: false, hmr: false, watch: null },
});
await server.listen();
const host = runtime ? await runtime.openWebView(server.resolvedUrls.local[0], entry) : null;
const browser = host?.browser ?? await chromium.launch({ channel: "chrome", headless: true });
const page = host?.page ?? await browser.newPage();
await page.setViewportSize({ width: 1680, height: 1050 });
await page.emulateMedia({ reducedMotion: "reduce" });
const fixtureUrl = `${server.resolvedUrls.local[0]}${entry}`;
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const modifier = process.platform === "darwin" ? "Meta" : "Control";
const origin = page.locator('[data-workflow-card="generator"]');
const media = page.locator('[data-canvas-node-id="generation-session"]');
const foregroundObstacle = page.locator('[data-canvas-node-id="old"]');
const image = media.locator('[data-conversation-image="a"]');
const preview = page.locator(".creation-image-preview");
const reply = page.getByRole("dialog", { name: "继续修改此图", exact: true });
const peek = page.locator('[data-workflow-peek]');
const pin = origin.getByRole("button", { name: "固定在画板上", exact: true });
const unpin = origin.getByRole("button", { name: "取消固定并收起", exact: true });
const readWorkflow = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("workflow-p")).document);
const waitForSourceX = (x, equals = true) => page.waitForFunction(
  ({ x, equals }) => (JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.find(node => node.id === "generator").x === x) === equals,
  { x, equals },
);
const stage = page.locator("[data-canvas-stage]");
const canvasAsset = id => stage.locator(`[data-frequent-asset-id="${id}"]`);
const libraryAsset = id => page.locator(`.canvas-source-panel [data-asset-id="${id}"][draggable="true"]`).first();

async function center(locator) {
  await locator.waitFor();
  const box = await locator.boundingBox();
  assert.ok(box);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function startLibraryDrag() {
  await page.getByRole("button", { name: "展开画板素材库", exact: true }).click();
  const asset = libraryAsset("b");
  await asset.hover();
  let drag;
  if (native) {
    // The hidden WebView2 fixture does not deliver CDP drag interception.
    // Exercise the component's native handoff and replay the OS drop events.
    const source = await asset.elementHandle();
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await page.evaluate(() => { window.holdNativeLibraryDrag = true; });
    await source.evaluate((element, dataTransfer) => element.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer })), dataTransfer);
    assert.equal(await dataTransfer.evaluate(data => data.getData("text/plain")), "b", "sidebar component sets the library drag payload");
    await page.waitForFunction(() => typeof window.finishNativeLibraryDrag === "function");
    assert.deepEqual(await page.evaluate(() => window.calls.findLast(call => call.command === "start_external_drag")?.args.assetIds), ["b"]);
    const send = (type, point) => page.evaluate(({ type, point, dataTransfer }) => {
      const hit = document.elementFromPoint(point.x, point.y);
      const stage = hit?.closest("[data-canvas-stage]");
      if (!stage) throw new Error("Library drag target is outside the canvas");
      const target = type === "drop" ? stage : hit;
      const event = new DragEvent(type.toLowerCase(), { bubbles: true, cancelable: true, dataTransfer, clientX: point.x, clientY: point.y });
      const accepted = !target.dispatchEvent(event);
      if (!accepted && type !== "dragEnter") throw new Error(`Canvas did not accept ${type}, target=${target.className}, payload=${dataTransfer.getData("text/plain")}`);
    }, { type, point, dataTransfer });
    drag = { send, drop: async point => {
      for (const type of ["dragEnter", "dragOver", "drop"]) await send(type, point);
      await source.dispatchEvent("dragend", { dataTransfer });
      await page.evaluate(() => {
        window.finishNativeLibraryDrag({ dropped: true });
        window.finishNativeLibraryDrag = undefined;
      });
      await dataTransfer.dispose();
      await source.dispose();
    } };
  } else {
    const start = await center(asset);
    const { session, data } = await startBrowserDrag(page, start.x, start.y);
    drag = { send: (type, point) => session.send("Input.dispatchDragEvent", { type, data, ...point }),
      drop: point => finishBrowserDrag(session, data, point.x, point.y) };
  }
  await page.locator('.canvas-source-panel[aria-hidden="true"]').waitFor({ state: "attached" });
  return drag;
}

async function blankPoint(width = 250, height = 200) {
  return stage.evaluate((element, { width, height }) => {
    const stage = element.getBoundingClientRect();
    const cards = [...element.querySelectorAll("[data-canvas-node], [data-workflow-card]")].map(card => card.getBoundingClientRect());
    for (let y = stage.top + 100; y <= stage.bottom - height - 60; y += 55) {
      for (let x = stage.left + 100; x <= stage.right - width - 30; x += 55) {
        const hit = document.elementFromPoint(x, y);
        if (hit && element.contains(hit) && !hit.closest("[data-canvas-node], [data-workflow-card], button, [role=toolbar]")
          && cards.every(card => x + width + 20 <= card.left || x >= card.right + 20 || y + height + 20 <= card.top || y >= card.bottom + 20)) return { x, y };
      }
    }
    throw new Error("No unobstructed position for a fixture card");
  }, { width, height });
}

async function loadInteractionBoard(collapsed) {
  await page.mouse.move(2, 2);
  await page.goto(`${fixtureUrl}?source-library&canvas-library`);
  await foregroundObstacle.waitFor();
  await page.evaluate(async collapsed => {
    const { newWorkflowNode } = await import("/src/lib/canvasWorkflow.ts");
    const snapshot = window.snapshot();
    const old = { ...snapshot.nodes.find(node => node.id === "old"), x: 90, y: 510, zIndex: 1 };
    const generator = { ...newWorkflowNode("generation", 650, 240, "codex"), id: "generator", prompt: "生成测试鸟" };
    const moving = { ...newWorkflowNode("instruction", 1120, 490, "codex"), id: "moving-workflow", prompt: "合成拖动卡片" };
    snapshot.nodes = [old];
    snapshot.view = { ...snapshot.view, panX: 85, panY: 70, zoom: 0.95 };
    snapshot.groups = []; snapshot.groupItems = []; snapshot.edges = [];
    if (collapsed) {
      const group = `workflow:${JSON.stringify(["p", generator.id])}`;
      const session = { ...old, id: "generation-session", x: generator.x, y: generator.y, width: 260, height: 205,
        kind: "prompt", role: null, assetId: null, createdAt: 2,
        payloadJson: JSON.stringify({ schema_version: 1, status: "done", job_id: "older-job", turn_key: "older-turn", provider: "codex", workflow_generation_group: group }) };
      snapshot.nodes.push(session, { ...session, id: "older-output", kind: "asset", role: "output", assetId: "a", outputIsVideo: false,
        payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: "合成参考 a", width: 190, height: 150 },
          workflow_generation_group: group, execution: { job_id: "older-job", turn_key: "older-turn" } }) });
      generator.activeSessionNodeId = session.id;
      generator.sessionNodeIds = [session.id];
    }
    sessionStorage.setItem("workflow-p", JSON.stringify({ revision: 1, document: { schema_version: 1, nodes: [generator, moving], run: null } }));
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  }, collapsed);
  await page.reload();
  await (collapsed ? image : origin).waitFor();
}

async function installControlledGeneration() {
  await page.evaluate(async () => {
    const { api } = await import("/src/lib/api.ts");
    const { FREE_POLICY } = await import("/src/lib/entitlement.ts");
    window.store.setState({ codexHealth: { ok: true }, cloudAuth: { logged_in: true, cloud_available: true },
      cloudEntitlement: { policy: { ...FREE_POLICY, can_use_byo: true, max_parallel_jobs: 5 }, balances: { daily: 100, sub: 0, topup: 0 } },
      startGeneration: async (...args) => {
        const { jobId, turnKey } = args[12];
        const { threadId } = args[9];
        const source = JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.find(node => node.id === "generator");
        const sessionId = `gen-prompt:${jobId}:${turnKey}:0`;
        const group = `workflow:${JSON.stringify(["p", source.id])}`;
        const payload = { schema_version: 1, job_id: jobId, turn_key: turnKey, text: args[0], provider: args[3], workflow_generation_group: group };
        const base = { ...window.snapshot().nodes.find(node => node.id === "old"), projectId: "p", threadId,
          id: sessionId, x: source.x, y: source.y, width: 260, height: 205, createdAt: 10 };
        return await new Promise(resolve => {
          window.controlledTurn = {
            sessionId,
            accept: () => resolve({ accepted: true, jobId }),
            status: async (status, output = false) => {
              const canvas = window.snapshot();
              const session = canvas.nodes.some(node => node.id === sessionId);
              const update = JSON.stringify({ ...payload, status, ...(status === "failed" ? { error: "合成验收失败" } : {}) });
              if (session) await api.projectCanvasNoteUpdate(sessionId, update);
              else await api.projectCanvasNodeCreate({ ...base, kind: "prompt", role: null, assetId: null, payloadJson: update });
              const [asset] = await api.getAssetsByIds(["d"]);
              if (output) await api.projectCanvasNodeCreate({ ...base, id: `gen-output:${jobId}:${turnKey}:d`, kind: "asset", role: "output", assetId: "d", outputIsVideo: false,
                payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: asset.name, width: asset.width, height: asset.height },
                  workflow_generation_group: group, execution: { job_id: jobId, turn_key: turnKey } }) });
              window.store.setState(state => ({ genJobs: { ...state.genJobs, [jobId]: { id: jobId, projectId: "p", threadId, provider: args[3],
                running: status === "running", turns: [{ id: 1, turnKey, prompt: args[0], images: output ? [asset.store_path] : [],
                  ...(status === "failed" ? { error: "合成验收失败" } : {}) }] } } }));
              window.emitChange();
            },
          };
        });
      } });
  });
}

async function watchRunningCard() {
  await origin.locator("xpath=self::*[@aria-busy='true']").waitFor();
  await origin.evaluate(card => {
    const violations = new Set();
    const samples = [];
    let borderIssue;
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === "childList" && Array.from(record.removedNodes).some(node => node === card || node.contains(card))) violations.add("running card DOM was detached");
        if (record.target === card && record.attributeName === "class" && !record.oldValue?.split(/\s+/).includes("canvas-card-running")) violations.add("running class was lost");
        if (record.target === card && record.attributeName === "aria-busy" && record.oldValue !== "true") violations.add("busy state was lost");
      }
    });
    const animation = () => card.getAnimations({ subtree: true }).find(item => item.animationName === "canvas-running-border");
    const initialAnimation = animation();
    const position = [card.style.left, card.style.top];
    const stage = card.closest("[data-canvas-stage]");
    let frame;
    const sample = () => {
      const bounds = stage.getBoundingClientRect(), box = card.getBoundingClientRect();
      if (document.querySelector('[data-workflow-card="generator"]') !== card || !card.isConnected || !box.width || !box.height
        || box.left >= bounds.right || box.right <= bounds.left || box.top >= bounds.bottom || box.bottom <= bounds.top) violations.add("running card was replaced or hidden");
      if (card.style.left !== position[0] || card.style.top !== position[1]) violations.add("running card left its starting position");
      const style = getComputedStyle(card, "::after");
      const active = animation();
      if (style.animationName !== "canvas-running-border" || style.animationIterationCount !== "infinite" || !active || initialAnimation !== active || active.playState !== "running") {
        violations.add("running border was stopped or restarted");
        borderIssue ??= { css: style.animationName, iterations: style.animationIterationCount, animation: active?.playState,
          sameAnimation: initialAnimation === active, className: card.className, busy: card.getAttribute("aria-busy") };
      }
      const time = Number(active?.currentTime);
      if (samples.length && time < samples.at(-1)) violations.add("running border time went backwards");
      if (Number.isFinite(time)) samples.push(time);
      frame = requestAnimationFrame(sample);
    };
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ["class", "aria-busy"] });
    frame = requestAnimationFrame(sample);
    window.runningTrace = stop => {
      if (stop) { observer.disconnect(); cancelAnimationFrame(frame); }
      return { violations: [...violations], borderIssue, frames: samples.length, time: samples.at(-1) - samples[0] };
    };
  });
}

async function addCardsDuringRun() {
  const ids = new Set((await readWorkflow()).nodes.map(node => node.id));
  await page.getByRole("button", { name: "新增指令卡片", exact: true }).click();
  const toolboxPoint = await blankPoint();
  await page.mouse.click(toolboxPoint.x, toolboxPoint.y);
  await page.waitForFunction(ids => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.some(node => !ids.includes(node.id)), [...ids]);
  const added = (await readWorkflow()).nodes.find(node => !ids.has(node.id));
  const card = page.locator(`[data-workflow-card="${added.id}"]`);
  const start = await center(card.locator("header strong"));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 62, start.y + 44, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(added => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.some(node => node.id === added.id && node.x !== added.x), added);
  const menuPoint = await blankPoint();
  await page.mouse.dblclick(menuPoint.x, menuPoint.y);
  await page.getByRole("menu", { name: "新建卡片", exact: true }).getByRole("menuitem", { name: "图片反推", exact: true }).click();
  await page.waitForFunction(count => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.length === count, ids.size + 2);
  const external = await blankPoint();
  await stage.evaluate(async (element, point) => {
    const { newWorkflowNode } = await import("/src/lib/canvasWorkflow.ts");
    const { LOCAL_CHAT_CARDS_CHANGED_EVENT } = await import("/src/lib/localChat.ts");
    const bounds = element.getBoundingClientRect();
    const plane = new DOMMatrix(getComputedStyle(element.querySelector(".canvas-plane")).transform);
    const { x, y } = new DOMPoint(point.x - bounds.left, point.y - bounds.top).matrixTransform(plane.inverse());
    const saved = JSON.parse(sessionStorage.getItem("workflow-p"));
    saved.revision++;
    saved.document.nodes.push({ ...newWorkflowNode("instruction", x, y, "codex"), id: "external-instruction", prompt: "外部来源建卡" });
    sessionStorage.setItem("workflow-p", JSON.stringify(saved));
    window.emitFixtureEvent(LOCAL_CHAT_CARDS_CHANGED_EVENT, { projectId: "p", nativeCanvasChanged: false });
  }, external);
  await page.locator('[data-workflow-card="external-instruction"]').waitFor();
  const libraryDrag = await startLibraryDrag();
  const point = await blankPoint(190, 160);
  await libraryDrag.drop(point);
  const asset = canvasAsset("b");
  const assetStart = await center(asset);
  const assetId = await asset.getAttribute("data-canvas-node-id");
  await page.waitForFunction(id => window.snapshot().nodes.some(node => node.id === id), assetId);
  const before = await page.evaluate(id => window.snapshot().nodes.find(node => node.id === id), assetId);
  await page.mouse.move(assetStart.x, assetStart.y);
  await page.mouse.down();
  await page.mouse.move(assetStart.x + 55, assetStart.y + 42, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(before => window.snapshot().nodes.some(node => node.id === before.id && node.x !== before.x && node.y !== before.y), before);
}

async function runningSurvivesCanvasEdits(kind) {
  const recalled = kind !== "first";
  await loadInteractionBoard(recalled);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installControlledGeneration();
  if (recalled) {
    await media.hover();
    await peek.waitFor();
    if (kind.startsWith("pin")) await pin.click();
  }
  await origin.getByRole("button", { name: "运行此卡片", exact: true }).click();
  await page.waitForFunction(() => !!window.controlledTurn);
  await watchRunningCard();
  await page.evaluate(() => window.controlledTurn.accept());
  await page.waitForFunction(() => {
    const { run } = JSON.parse(sessionStorage.getItem("workflow-p")).document;
    return run?.steps?.generator?.status === "done";
  });
  const sessionId = await page.evaluate(() => window.controlledTurn.sessionId);
  assert.equal(await page.evaluate(id => window.snapshot().nodes.some(node => node.id === id), sessionId), false, "the submission receipt deliberately arrives before its session");
  assert.deepEqual((await page.evaluate(() => window.runningTrace(false))).violations, [], `${kind}: accepting submission without a session must not stop the running card`);
  await addCardsDuringRun();
  const afterEdits = await page.evaluate(() => window.runningTrace(false));
  assert.deepEqual(afterEdits.violations, [], `${kind}: busy card and its original animation survive toolbox, double-click, external attachment, drop and dragging during the session gap`);
  assert.ok(afterEdits.frames >= 5 && afterEdits.time > 150, `${kind}: running border actually advanced: ${JSON.stringify(afterEdits)}`);
  await page.evaluate(() => window.controlledTurn.status("running"));
  await page.waitForTimeout(260);
  const working = await page.evaluate(() => window.runningTrace(false));
  assert.deepEqual(working.violations, [], `${kind}: publishing the pending session retains the running card ${JSON.stringify(working.borderIssue)}`);
  if (kind !== "pin-failure") {
    await page.evaluate(() => window.controlledTurn.status("done"));
    await page.waitForTimeout(320);
    assert.equal(await page.locator('[data-conversation-image="d"]').count(), 0, "terminal status is published before the new result");
  }
  const trace = await page.evaluate(() => window.runningTrace(true));
  assert.deepEqual(trace.violations, [], `${kind}: the original busy card and border remain until terminal handoff ${JSON.stringify(trace.borderIssue)}`);
  const away = await blankPoint();
  await page.mouse.move(away.x, away.y);
  if (kind === "pin-failure") {
    await page.evaluate(() => window.controlledTurn.status("failed"));
    await image.waitFor();
  } else {
    await page.evaluate(() => window.controlledTurn.status("done", true));
    await stage.locator('[data-conversation-image="d"]').waitFor();
  }
  await origin.waitFor({ state: "detached" });
}

async function watchNoPeek() {
  assert.equal(await peek.count(), 0);
  await page.evaluate(() => {
    let mounts = 0;
    const check = records => {
      if (document.querySelector("[data-workflow-peek]") || records.some(record => record.attributeName === "data-workflow-peek"
        || Array.from(record.addedNodes).some(node => node instanceof Element && (node.matches("[data-workflow-peek]") || node.querySelector("[data-workflow-peek]"))))) mounts++;
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-workflow-peek"] });
    window.stopPeekTrace = () => { check(observer.takeRecords()); observer.disconnect(); return mounts; };
  });
}

async function dragMustNotPeek(type) {
  await loadInteractionBoard(true);
  const target = await center(media);
  await watchNoPeek();
  if (type === "library") {
    const libraryDrag = await startLibraryDrag();
    const destination = await center(media);
    for (const event of ["dragEnter", "dragOver"]) await libraryDrag.send(event, destination);
    await page.waitForTimeout(320);
    assert.equal(await peek.count(), 0, "a library drag has been held over the collapsed result for over 250 ms");
    const drop = await blankPoint(190, 160);
    await libraryDrag.drop(drop);
    await canvasAsset("b").waitFor();
  } else {
    const moving = type === "workflow" ? page.locator('[data-workflow-card="moving-workflow"] header strong') : type === "rapid" ? media : foregroundObstacle;
    let start = await center(moving);
    if (type === "rapid") {
      const away = await blankPoint();
      await page.mouse.move(away.x, away.y);
      await media.evaluate(element => {
        window.rapidDragTiming = {};
        element.addEventListener("pointerenter", event => {
          const timing = window.rapidDragTiming;
          if (timing.enter === undefined) timing.enter = event.timeStamp;
          else if (timing.up !== undefined && timing.reenter === undefined) timing.reenter = event.timeStamp;
        });
        element.addEventListener("pointerdown", event => { window.rapidDragTiming.down = event.timeStamp; }, { once: true });
        document.addEventListener("pointerup", event => { window.rapidDragTiming.up = event.timeStamp; }, { once: true, capture: true });
        document.addEventListener("pointermove", event => {
          const timing = window.rapidDragTiming;
          if (timing.down !== undefined && timing.up === undefined) timing.moved = event.timeStamp;
        }, { capture: true });
      });
      start = { x: target.x, y: target.y };
    }
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    const over = type === "rapid" ? { x: target.x + 80, y: target.y + 42 } : target;
    await page.mouse.move(over.x, over.y, { steps: type === "rapid" ? 1 : 5 });
    if (type !== "rapid") {
      await page.waitForTimeout(320);
      assert.equal(await peek.count(), 0, `${type}: crossing and pausing over collapsed media does not open Peek`);
      const clearDrop = await blankPoint(250, 230);
      await page.mouse.move(clearDrop.x + 120, clearDrop.y + 50);
    }
    await page.mouse.up();
    if (type === "rapid") {
      const away = await blankPoint();
      await page.mouse.move(away.x, away.y);
      const back = await center(media);
      await page.mouse.move(back.x, back.y);
      const { enter, down, moved, up, reenter } = await page.evaluate(() => window.rapidDragTiming);
      assert.ok(enter <= down && down <= moved && moved <= up && up - enter < 160, `rapid drag and release must finish within 160 ms: ${JSON.stringify({ enter, down, moved, up, reenter })}`);
      assert.ok(reenter >= up && reenter - up < 250, `pointer entered during the 250 ms release cooldown: ${JSON.stringify({ up, reenter })}`);
    }
  }
  await page.waitForTimeout(260);
  assert.equal(await page.evaluate(() => window.stopPeekTrace()), 0, `${type}: never mounted a Peek during drag or on release`);
  const away = await blankPoint();
  await page.mouse.move(away.x, away.y);
  await media.hover();
  await peek.waitFor();
  await page.mouse.move(away.x, away.y);
  await peek.waitFor({ state: "detached" });
  await image.click();
  await preview.waitFor();
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "detached" });
}

const resultAnchor = id => stage.locator(`[data-canvas-node-id="${id}"]`);
const workflowCard = id => stage.locator(`[data-workflow-card="${id}"]`);
const outputHandle = id => stage.locator(`[data-workflow-material="${id}"] [data-canvas-connect-side="output"], [data-workflow-card="${id}"] [data-canvas-connect-side="output"], [data-canvas-node-id="${id}"] [data-canvas-connect-side="output"]`).first();
const currentInputs = async () => (await readWorkflow()).nodes.find(node => node.id === "generator").inputs;
const connectionNotice = page.locator(".canvas-connection-notice");

async function seedConnectionBoard(kind) {
  await loadInteractionBoard(true);
  const anchorId = await page.evaluate(async ({ kind }) => {
    const { newWorkflowNode } = await import("/src/lib/canvasWorkflow.ts");
    const { DEFAULT_COMFY_VIDEO } = await import("/src/lib/comfyVideo.ts");
    const { DEFAULT_VIDEO_OPTIONS } = await import("/src/lib/videoGeneration.ts");
    const { revision, document } = JSON.parse(sessionStorage.getItem("workflow-p"));
    const canvas = window.snapshot();
    const base = canvas.nodes.find(node => node.id === "old");
    const origin = document.nodes.find(node => node.id === "generator");
    const image = ["image", "menu", "locked"].includes(kind);
    const local = kind.startsWith("h3"), frames = kind.endsWith("frames");
    const group = `workflow:${JSON.stringify(["p", origin.id])}`;
    const anchorId = image ? "generation-session" : local ? "workflow-comfy:fixture-h3" : "gen-output:fixture-video:older:0";
    const videoConfig = { media: "video", videoChannel: "jimeng", ratio: "16:9", videoOptions: { ...DEFAULT_VIDEO_OPTIONS,
      kind: frames ? "frames2video" : "multimodal2video", model_version: "seedance2.5" } };
    canvas.nodes = [
      { ...base, x: 55, y: 220 },
      ...canvas.nodes.filter(node => node.id !== "old"),
      { ...base, id: "second-photo", assetId: "b", x: 150, y: 470,
        payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: "合成参考 b", width: 190, height: 150 } }) },
    ];
    if (!image) {
      const targetAsset = { id: "output-video", name: "视频产物", ext: "mp4", width: 320, height: 180, duration: 1,
        store_path: "/fixture/output-video.mp4", thumb_path: window.store.getState().assets.find(asset => asset.id === "a").store_path };
      const inputAsset = { ...targetAsset, id: "source-video", name: "视频来源", store_path: "/fixture/source-video.mp4" };
      sessionStorage.setItem("reference-drafts", JSON.stringify([targetAsset, inputAsset]));
      canvas.nodes = canvas.nodes.filter(node => node.id !== "generation-session" && node.id !== "older-output");
      const sessionId = "gen-prompt:fixture-video:older:0";
      const execution = { job_id: "fixture-video", turn_key: "older" };
      if (!local) canvas.nodes.push({ ...base, id: sessionId, kind: "prompt", role: null, assetId: null, x: origin.x, y: origin.y,
        payloadJson: JSON.stringify({ ...execution, status: "done", workflow_generation_group: group }) });
      canvas.nodes.push({ ...base, id: anchorId, role: "output", assetId: targetAsset.id, outputIsVideo: true, x: origin.x, y: origin.y, width: 260, height: 146,
        payloadJson: JSON.stringify({ schema_version: 1, workflow_source: origin.id, workflow_generation_group: group,
          ...(!local && { execution }), snapshot: { name: targetAsset.name, width: 320, height: 180 } }) });
      canvas.nodes.push({ ...base, id: "video-media-source", assetId: inputAsset.id, x: 130, y: 680, width: 260, height: 146,
        payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: inputAsset.name, width: 320, height: 180 } }) });
      Object.assign(origin, { ...(local ? { kind: "comfy-video", comfyVideo: { ...DEFAULT_COMFY_VIDEO, mode: frames ? "frames" : "r2v" } }
        : { generation: videoConfig }), activeSessionNodeId: local ? null : sessionId, sessionNodeIds: local ? [] : [sessionId],
        resultNodeIds: local ? [anchorId] : [], outputs: { image: { type: "image", assetIds: [targetAsset.id] } } });
    }
    document.nodes = [origin];
    if (kind === "image") {
      document.nodes.push({ ...newWorkflowNode("generation", 1135, 170, "codex"), id: "dependent",
        inputs: { image: [{ nodeId: origin.id, portId: "image" }] } });
      canvas.nodes.push({ ...base, id: "text-source", kind: "note", assetId: null, role: null, x: 1125, y: 590, width: 280, height: 130,
        payloadJson: JSON.stringify({ schema_version: 1, note_type: "document", title: "文本来源", text: "只连接文字", cells: [], member_ids: [] }) });
    }
    if (frames) document.nodes.push({ ...newWorkflowNode("generation", 1110, 183, "jimeng"), id: "video-producer", generation: videoConfig });
    document.cardNames = { generator: "目标生成卡", [anchorId]: "可见生成结果" };
    sessionStorage.setItem("workflow-p", JSON.stringify({ revision, document }));
    sessionStorage.setItem("reference-fixture", JSON.stringify(canvas));
    return anchorId;
  }, { kind });
  await page.reload();
  await resultAnchor(anchorId).waitFor();
  await origin.waitFor({ state: "detached" });
  return anchorId;
}

async function startConnection(source, target, selection = false) {
  const sourceControl = selection ? page.getByRole("button", { name: "连接所选素材", exact: true }) : outputHandle(source);
  if (!selection) await stage.locator(`[data-canvas-node-id="${source}"], [data-workflow-card="${source}"]`).first().hover();
  const start = await center(sourceControl);
  const point = await center(resultAnchor(target));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 12 });
  return page.locator(`[data-connection-target="${target}"]`);
}

async function dropConnection(source, target, selection = false) {
  const feedback = await startConnection(source, target, selection);
  try {
    const label = await feedback.getAttribute("aria-label");
    assert.equal(label, "可以连接", `${source} over ${target} should target the visible result`);
    assert.equal(await feedback.evaluate(el => el.classList.contains("is-invalid")), false);
    assert.equal(await connectionNotice.filter({ hasText: /这张卡片不能接收内容/ }).count(), 0);
    assert.equal(await origin.count(), 0, "hover validation alone keeps the generator folded");
  } finally { await page.mouse.up(); }
}

async function waitForInput(port, expected) {
  await page.waitForFunction(({ port, expected }) => {
    const nodes = JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes;
    return (nodes.find(node => node.id === "generator").inputs[port] ?? []).some(input => Object.entries(expected).every(([key, value]) =>
      key === "position" ? input.videoFrame?.position === value : input[key] === value));
  }, { port, expected });
}

async function assertConnectedAndPinned(anchorId, port, binding) {
  await waitForInput(port, binding);
  await stage.locator('[data-workflow-card="generator"][data-workflow-pinned]').waitFor();
  const [card, anchor] = await Promise.all([origin.boundingBox(), resultAnchor(anchorId).boundingBox()]);
  assert.ok(card && anchor && card.x + card.width <= anchor.x, "the generator is pinned to the left of its result");
  await page.waitForFunction(() => document.activeElement?.matches('textarea, [contenteditable="true"]')
    && document.activeElement.closest('[data-workflow-card="generator"]'));
}

async function reconnectImageResult() {
  const anchor = await seedConnectionBoard("image");
  for (const [source, error, multiple] of [[anchor, null, false], [anchor, /自身/, true], ["dependent", /循环/, false]]) {
    if (multiple) for (const id of ["old", anchor]) await resultAnchor(id).click({ modifiers: [modifier] });
    const feedback = await startConnection(source, anchor, multiple);
    try {
      if (error || await feedback.count()) assert.match(await feedback.getAttribute("aria-label"), error ?? /自身/);
    } finally { await page.mouse.up(); }
    assert.deepEqual(await currentInputs(), {});
    assert.equal(await origin.count(), 0, "invalid connections leave the generator folded");
    const point = await blankPoint();
    await page.mouse.click(point.x, point.y);
  }
  await dropConnection("old", anchor);
  await assertConnectedAndPinned(anchor, "image", { assetNodeId: "old", assetId: "existing" });
  await origin.locator('[data-workflow-reference-asset="existing"] img').waitFor();
  await unpin.click();
  await origin.waitFor({ state: "detached" });
  await dropConnection("old", anchor);
  await page.waitForTimeout(250);
  assert.equal(await origin.count(), 0, "a duplicate binding does not reopen the card");
  assert.equal((await currentInputs()).image.length, 1);
  await page.keyboard.press(`${modifier}+z`);
  await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.find(node => node.id === "generator").inputs.image?.length);
  const empty = await blankPoint();
  await page.mouse.click(empty.x, empty.y);
  for (const id of ["old", "second-photo"]) await resultAnchor(id).click({ modifiers: [modifier] });
  await dropConnection("old", anchor, true);
  await assertConnectedAndPinned(anchor, "image", { assetNodeId: "second-photo", assetId: "b" });
  assert.deepEqual((await currentInputs()).image.map(input => input.assetId), ["existing", "b"]);
  await origin.locator('[data-workflow-reference-asset="b"] img').waitFor();
  const prompt = origin.locator('[contenteditable="true"]');
  const original = await prompt.textContent();
  await page.keyboard.press("End");
  await page.keyboard.insertText("校验编辑");
  await prompt.getByText(/校验编辑/).waitFor();
  await page.keyboard.press(`${modifier}+z`);
  await page.waitForFunction(original => document.querySelector('[data-workflow-card="generator"] [contenteditable="true"]')?.textContent === original, original);
  assert.deepEqual((await currentInputs()).image.map(input => input.assetId), ["existing", "b"], "undoing typed text preserves the most recent connection");
  await unpin.click();
  await origin.waitFor({ state: "detached" });
  await dropConnection("text-source", anchor);
  await assertConnectedAndPinned(anchor, "text", { canvasNodeId: "text-source" });
  assert.deepEqual((await currentInputs()).image.map(input => input.assetId), ["existing", "b"]);
}

async function reconnectWithMenuAndUndo() {
  const anchor = await seedConnectionBoard("menu");
  const handle = outputHandle("old");
  await handle.focus();
  await handle.press("Enter");
  await page.getByRole("menu", { name: "添加下游", exact: true }).getByRole("menuitem", { name: "连接已有卡片", exact: true }).click();
  const items = page.getByRole("menu", { name: "连接已有卡片", exact: true }).getByRole("menuitem");
  assert.equal(await items.count(), 1, "the folded generator and its current result are one menu candidate");
  await items.first().click();
  await assertConnectedAndPinned(anchor, "image", { assetNodeId: "old" });
  await page.keyboard.press(`${modifier}+z`);
  await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.find(node => node.id === "generator").inputs.image?.length);
  assert.equal(await origin.locator('[data-workflow-reference-asset="existing"]').count(), 0);
  assert.equal(await origin.getAttribute("data-workflow-pinned"), "", "undo keeps the card open for editing");
}

async function reconnectVideoResult(kind) {
  const id = await seedConnectionBoard(kind);
  const local = kind.startsWith("h3"), frames = kind.endsWith("frames");
  const imagePort = local ? frames ? "first-frame" : "reference-image" : "image";
  await dropConnection("old", id);
  await assertConnectedAndPinned(id, imagePort, { assetNodeId: "old", assetId: "existing" });
  if (local && frames) await origin.locator(".comfy-frame-thumbnail").waitFor();
  else if (local) await origin.getByRole("group", { name: "参考图片输入" }).getByText("合成参考 existing", { exact: true }).waitFor();
  else await origin.locator('[data-workflow-reference-asset="existing"] img').waitFor();
  await unpin.click();
  await origin.waitFor({ state: "detached" });
  await dropConnection(frames ? "video-producer" : "video-media-source", id);
  const menu = page.getByRole("menu", { name: "引用视频", exact: true });
  await menu.waitFor();
  const choice = menu.getByRole("menuitem", { name: "引用完整视频", exact: true });
  assert.equal(await choice.isDisabled(), frames, "the selected mode determines full video support");
  for (const option of ["引用首帧画面", "引用尾帧画面"]) assert.equal(await menu.getByRole("menuitem", { name: option, exact: true }).isEnabled(), true);
  assert.equal(await origin.count(), 0, "video choice does not pin an uncommitted connection");
  const label = local ? "引用尾帧画面" : "引用首帧画面";
  await (frames ? menu.getByRole("menuitem", { name: label, exact: true }) : choice).click();
  await assertConnectedAndPinned(id, local ? frames ? "last-frame" : "reference-video" : "image", frames
    ? { nodeId: "video-producer", portId: "image", position: local ? "last" : "first" }
    : { assetNodeId: "video-media-source", assetId: "source-video" });
  if (local && !frames) {
    await origin.getByRole("group", { name: "参考视频输入" }).getByText("视频来源", { exact: true }).waitFor();
    assert.equal(await origin.getByRole("textbox", { name: "卡片指令" }).evaluate(input => input === document.activeElement), true);
    await page.keyboard.press(`${modifier}+z`);
    await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.find(node => node.id === "generator").inputs["reference-video"]?.length);
    assert.deepEqual((await currentInputs())["reference-image"].map(input => input.assetId), ["existing"], "first undo in the H3 prompt keeps the earlier image link");
    assert.equal(await origin.getAttribute("data-workflow-pinned"), "");
  }
}

async function rejectConnectionWhileGenerationIsPending() {
  const anchor = await seedConnectionBoard("locked");
  await installControlledGeneration();
  await media.hover();
  await peek.waitFor();
  await origin.getByRole("button", { name: "运行此卡片", exact: true }).click();
  await page.waitForFunction(() => !!window.controlledTurn);
  await page.evaluate(() => window.controlledTurn.accept());
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.run?.steps?.generator?.status === "done");
  assert.equal(await origin.getAttribute("aria-busy"), "true");
  const feedback = await startConnection("old", anchor);
  try { assert.match(await feedback.getAttribute("aria-label"), /正在运行|正在使用/); }
  finally { await page.mouse.up(); }
  assert.deepEqual(await currentInputs(), {});
  assert.equal(await origin.getAttribute("data-workflow-pinned"), null, "rejected input leaves the existing Peek presentation intact");
  await page.evaluate(() => window.controlledTurn.status("failed"));
  await origin.waitFor({ state: "detached" });
}
async function captureThemes(name) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.screenshot({ path: `${evidence}/${name}-${theme}.png` });
  }
}

async function assertPeekAgainstAnchor(zoom = 1) {
  const card = await origin.boundingBox(), anchor = await media.boundingBox();
  assert.ok(card && anchor);
  assert.ok(Math.abs(anchor.x - (card.x + card.width) - 12 * zoom) < 1);
  assert.ok(Math.abs(anchor.y - card.y) < 1);
}

async function assertPeekWinsHitTest() {
  const card = await origin.boundingBox(), obstacle = await foregroundObstacle.boundingBox();
  const left = Math.max(card.x, obstacle.x), right = Math.min(card.x + card.width, obstacle.x + obstacle.width);
  const top = Math.max(card.y, obstacle.y), bottom = Math.min(card.y + card.height, obstacle.y + obstacle.height);
  assert.ok(left < right && top < bottom, "the high-layer material physically overlaps the generator");
  const id = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-workflow-card]')?.dataset.workflowCard,
    { x: (left + right) / 2, y: (top + bottom) / 2 });
  assert.equal(id, "generator");
}

try {
  await mkdir(evidence, { recursive: true });
  if (!host) await page.goto(fixtureUrl);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { newWorkflowNode } = await import("/src/lib/canvasWorkflow.ts");
    const snapshot = window.snapshot();
    const base = snapshot.nodes[0];
    const generator = { ...newWorkflowNode("generation", 450, 180, "codex"), id: "generator", prompt: "生成一只鸟",
      activeSessionNodeId: "generation-session", sessionNodeIds: ["generation-session"],
      inputs: { image: [{ assetId: "existing", assetNodeId: "old", autoConnect: "upstream" }], text: [] } };
    const downstream = { ...newWorkflowNode("generation", 1000, 180, "codex"), id: "downstream", prompt: "生成鸟巢",
      inputs: { image: [{ nodeId: generator.id, portId: "image", autoConnect: "downstream" }], text: [] } };
    sessionStorage.setItem("workflow-p", JSON.stringify({ revision: 1, document: { version: 1, nodes: [generator, downstream] } }));
    const group = "workflow:" + JSON.stringify(["p", generator.id]);
    const session = { ...base, id: "generation-session", kind: "prompt", assetId: null, role: null, x: 450, y: 180, width: 274, height: 150,
      payloadJson: JSON.stringify({ schema_version: 1, job_id: "job", turn_key: "first-turn", text: "生成一只鸟",
        workflow_generation_group: group, status: "running", provider: "codex" }) };
    snapshot.nodes = [{ ...base, x: 20, y: 195, zIndex: 2_500_000 }, session];
    snapshot.view = { ...snapshot.view, panX: 100, panY: 100, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await page.reload();
  await origin.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-workflow-card="generator"]')?.classList.contains("canvas-card-running"));
  assert.equal(await media.count(), 0, "the submitted session does not occupy a second card");
  assert.equal(await origin.evaluate(card => getComputedStyle(card, "::after").animationName), "none");
  await captureThemes("running");
  await page.evaluate(async () => {
    const { api } = await import("/src/lib/api.ts");
    const session = window.snapshot().nodes.find(node => node.id === "generation-session");
    await api.projectCanvasNoteUpdate(session.id, JSON.stringify({ ...JSON.parse(session.payloadJson), status: "failed" }));
    window.emitChange();
  });
  await origin.getByRole("alert").getByRole("button", { name: "查看生成详情" }).waitFor();
  assert.equal(await media.count(), 0, "a first failure stays on its original generator");
  await page.evaluate(async () => {
    const { api } = await import("/src/lib/api.ts");
    const session = window.snapshot().nodes.find(node => node.id === "generation-session");
    await api.projectCanvasNodeCreate({ ...session, id: "malformed-output", kind: "asset", role: "output", assetId: "b",
      payloadJson: JSON.stringify({ execution: { job_id: "job", turn_key: "first-turn" } }) });
    await api.projectCanvasNoteUpdate(session.id, JSON.stringify({ ...JSON.parse(session.payloadJson), status: "done" }));
    window.emitChange();
  });
  await media.waitFor();
  assert.equal(await image.count(), 0);
  assert.equal(await origin.isVisible(), true, "missing media snapshot cannot replace the generator");
  await page.evaluate(async () => {
    const { api } = await import("/src/lib/api.ts");
    const session = window.snapshot().nodes.find(node => node.id === "generation-session");
    await api.projectCanvasNodeRemove("malformed-output");
    await api.projectCanvasNoteUpdate(session.id, JSON.stringify({ ...JSON.parse(session.payloadJson), status: "running" }));
    window.emitChange();
  });
  await origin.locator("header strong").click();
  const stop = origin.getByRole("button", { name: "停止生成", exact: true });
  await stop.focus();
  const originalPosition = await origin.boundingBox();
  await page.evaluate(async () => {
    const { api } = await import("/src/lib/api.ts");
    const session = window.snapshot().nodes.find(node => node.id === "generation-session");
    const payload = JSON.parse(session.payloadJson);
    const [asset] = await api.getAssetsByIds(["a"]);
    await api.projectCanvasNoteUpdate(session.id, JSON.stringify({ ...payload, status: "done" }));
    await api.projectCanvasNodeCreate({ ...session, id: "output-a", kind: "asset", role: "output", assetId: "a",
      width: 260, height: 205, payloadJson: JSON.stringify({ schema_version: 1,
        snapshot: { name: "合成参考 a", width: 190, height: 150 },
        workflow_generation_group: payload.workflow_generation_group, execution: { job_id: "job", turn_key: "first-turn" } }) });
    const turn = { id: 1, turnKey: "first-turn", prompt: "生成一只鸟", images: [asset.store_path], provider: "codex" };
    const job = { id: "job", projectId: "p", threadId: "t", conversationId: "conversation", sessionId: "provider-session",
      provider: "codex", running: false, turns: [turn] };
    const { FREE_POLICY } = await import("/src/lib/entitlement.ts");
    window.store.setState({ genJobs: { job }, codexHealth: { ok: true },
      cloudAuth: { logged_in: true, cloud_available: true },
      cloudEntitlement: { policy: { ...FREE_POLICY, can_use_byo: true, max_parallel_jobs: 3 }, balances: { daily: 100, sub: 0, topup: 0 } } });
    window.emitChange();
  });
  await image.waitFor();
  assert.equal(await origin.count(), 0);
  assert.match(await media.getAttribute("class"), /is-selected/);
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-canvas-node-id") === "generation-session");
  const mediaPosition = await media.boundingBox();
  assert.ok(Math.abs(mediaPosition.x - originalPosition.x) < 1);
  assert.ok(Math.abs(mediaPosition.y - originalPosition.y) < 1);
  assert.equal(await page.locator('[data-workflow-generator="generator"]').count(), 0);
  const incoming = page.locator('path[data-auto-connection="upstream"]');
  const outgoing = page.locator('path[data-auto-connection="downstream"]');
  await incoming.waitFor({ state: "attached" });
  await outgoing.waitFor({ state: "attached" });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const endpoints = await media.evaluate(card => {
    const plane = card.closest(".canvas-plane");
    const incoming = plane.querySelector('path[data-auto-connection="upstream"]');
    const outgoing = plane.querySelector('path[data-auto-connection="downstream"]');
    const measure = (line, start) => {
      const point = line.getPointAtLength(start ? 0 : line.getTotalLength());
      const matrix = line.getScreenCTM();
      return { anchor: point.x, screen: point.matrixTransform(matrix).x, matrix: [matrix.a, matrix.e],
        d: line.getAttribute("d"), path: getComputedStyle(line).d };
    };
    const rect = card.getBoundingClientRect();
    return { input: measure(incoming, false), output: measure(outgoing, true), left: rect.left, right: rect.right,
      plane: getComputedStyle(plane).transform };
  });
  assert.ok(Math.abs(endpoints.input.screen - endpoints.left) < 2, JSON.stringify(endpoints));
  assert.ok(Math.abs(endpoints.output.screen - endpoints.right) < 2, JSON.stringify(endpoints));

  await image.click({ modifiers: [modifier] });
  assert.doesNotMatch(await media.getAttribute("class"), /is-selected/);
  assert.equal(await preview.count(), 0);
  await image.click();
  await preview.waitFor();
  assert.equal(await page.locator("[data-project-inspector]").count(), 0);
  assert.equal(await preview.getByRole("button", { name: /在画布.*生成卡/ }).count(), 0);
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "detached" });
  const blank = { x: 80, y: 150 };
  await page.mouse.move(blank.x, blank.y);
  await origin.waitFor({ state: "detached" });
  await media.hover();
  await page.mouse.move(blank.x, blank.y);
  await page.waitForTimeout(200);
  assert.equal(await origin.count(), 0, "brief pass does not mount the editor");

  await page.keyboard.down("Space");
  await media.hover();
  await page.waitForTimeout(200);
  assert.equal(await origin.count(), 0, "space-to-pan keeps the editor hidden");
  await page.keyboard.up("Space");
  await page.mouse.move(blank.x, blank.y);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await media.hover();
  await origin.waitFor();
  assert.equal(await peek.count(), 1);
  await origin.evaluate(async card => {
    for (const [element, animationName, duration] of [[card, "workflow-peek-in", "0.2s"],
      [card.querySelector(".canvas-tactical-card-shell"), "workflow-peek-shell-connect", "0.16s"]]) {
      const animation = getComputedStyle(element);
      if (animation.animationName !== animationName || animation.animationDuration !== duration || animation.animationIterationCount !== "1") {
        throw new Error(`Expected one ${animationName} animation of ${duration}`);
      }
    }
    await Promise.all(card.getAnimations({ subtree: true }).filter(animation =>
      ["workflow-peek-in", "workflow-peek-shell-connect"].includes(animation.animationName)).map(animation => animation.finished));
    if (getComputedStyle(card).transform !== "none") throw new Error("The finished entry must release its transform");
  });
  const peekPosition = await origin.boundingBox();
  const anchorPosition = await media.boundingBox();
  await assertPeekAgainstAnchor();
  await assertPeekWinsHitTest();
  const obstacleZ = await foregroundObstacle.evaluate(card => Number(getComputedStyle(card).zIndex));
  assert.equal(obstacleZ, 2_500_000);
  assert.ok(await origin.evaluate(card => Number(getComputedStyle(card).zIndex)) > obstacleZ + 10000);
  assert.equal(await page.locator('[data-workflow-generator="generator"]').count(), 0, "peek leaves wires at the result anchor");
  await page.mouse.move(anchorPosition.x + 5, anchorPosition.y + 80);
  await page.mouse.move(anchorPosition.x - 5, anchorPosition.y + 80);
  await page.waitForTimeout(260);
  await peek.waitFor();
  const editor = origin.locator('[contenteditable="true"]');
  await editor.fill("生成一只蓝色的鸟");
  await page.mouse.move(blank.x, blank.y);
  await page.waitForTimeout(260);
  await peek.waitFor();
  await editor.evaluate(element => element.blur());
  await origin.waitFor({ state: "detached" });
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.find(node => node.id === "generator").prompt === "生成一只蓝色的鸟");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await media.hover();
  await peek.waitFor();
  assert.deepEqual(await origin.evaluate(card => [getComputedStyle(card).animationName,
    getComputedStyle(card.querySelector(".canvas-tactical-card-shell")).animationName]), ["none", "none"]);
  assert.equal(await editor.textContent(), "生成一只蓝色的鸟");
  await pin.click();
  assert.equal(await peek.count(), 0);
  assert.deepEqual(await origin.boundingBox(), peekPosition);
  await assertPeekWinsHitTest();
  await captureThemes("expanded");
  const sourceBeforePinDrag = (await readWorkflow()).nodes.find(node => node.id === "generator");
  const header = await origin.locator("header strong").boundingBox();
  await page.mouse.move(header.x + 10, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 75, header.y + header.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  await waitForSourceX(sourceBeforePinDrag.x, false);
  assert.notEqual((await origin.boundingBox()).x, peekPosition.x, "the pinned card can be dragged");
  await page.keyboard.press(`${modifier}+z`);
  await waitForSourceX(sourceBeforePinDrag.x);
  assert.deepEqual(await origin.boundingBox(), peekPosition);
  await unpin.click();
  await origin.waitFor({ state: "detached" });
  await media.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "固定生成卡", exact: true }).press("Enter");
  await origin.waitFor();
  assert.ok(await origin.evaluate(card => Number(getComputedStyle(card).zIndex)) > obstacleZ + 10000);
  await unpin.click();
  await origin.waitFor({ state: "detached" });

  await image.click({ button: "right" });
  await page.getByRole("menuitem", { name: "固定生成卡", exact: true }).click();
  await origin.waitFor();
  assert.equal(await unpin.getAttribute("aria-pressed"), "true");
  await unpin.click();
  await origin.waitFor({ state: "detached" });

  const change = media.getByRole("button", { name: "继续修改", exact: true });
  await media.hover();
  await change.focus();
  await page.keyboard.press("Enter");
  await reply.waitFor();
  await reply.getByRole("textbox", { name: "续轮对话", exact: true }).waitFor();
  await captureThemes("continuation");
  await page.keyboard.press("Escape");
  await reply.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "继续修改");
  await image.click({ button: "right" });
  await page.getByRole("menuitem", { name: "继续修改", exact: true }).click();
  await reply.waitFor();
  await page.evaluate(() => window.store.setState({ sendGenRevise: async (id, prompt, provider, options) => {
    const job = window.store.getState().genJobs[id];
    window.continuation = { id, prompt, options };
    window.store.setState({ genJobs: { [id]: { ...job, running: true, turns: [...job.turns,
      { id: 2, turnKey: "second-turn", prompt, images: [], provider }] } } });
  } }));
  const beforeRevision = await media.boundingBox();
  await reply.getByRole("textbox", { name: "续轮对话", exact: true }).fill("给鸟加上蓝色羽毛");
  await reply.getByRole("button", { name: "发送续轮对话", exact: true }).click();
  await reply.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.continuation.options.parentNodeId), "output-a");
  assert.equal(await page.evaluate(() => window.continuation.id), "job");
  assert.deepEqual(await media.boundingBox(), beforeRevision);
  assert.equal(await image.count(), 1, "a running revision retains the previous image");

  const beforeDrag = await readWorkflow();
  await page.mouse.move(blank.x, blank.y);
  await origin.waitFor({ state: "detached" });
  await media.hover();
  await peek.waitFor();
  const box = await image.boundingBox();
  await page.mouse.move(box.x + 65, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 145, box.y + 160, { steps: 5 });
  await page.waitForFunction(() => {
    const media = document.querySelector('[data-canvas-node-id="generation-session"]');
    const peek = document.querySelector('[data-workflow-peek-anchor="generation-session"]');
    return media?.style.translate && peek?.style.translate === media.style.translate;
  });
  await page.waitForTimeout(240);
  await assertPeekAgainstAnchor();
  await page.mouse.up();
  await waitForSourceX(beforeDrag.nodes[0].x, false);
  await assertPeekAgainstAnchor();
  assert.equal(await origin.evaluate(card => card.style.translate), "");
  const movedPeekPosition = await origin.boundingBox();
  await pin.click();
  assert.deepEqual(await origin.boundingBox(), movedPeekPosition, "pinning after release keeps the moved anchor's current position");
  await unpin.click();
  await origin.waitFor({ state: "detached" });
  await page.waitForTimeout(260);
  await media.hover();
  await peek.waitFor();
  await page.keyboard.press(`${modifier}+z`);
  await waitForSourceX(beforeDrag.nodes[0].x);
  await assertPeekAgainstAnchor();
  const obstacle = await foregroundObstacle.boundingBox();
  await page.mouse.move(obstacle.x + 15, obstacle.y + 35);
  await page.mouse.down();
  await page.mouse.move(obstacle.x + 33, obstacle.y + 60);
  await peek.waitFor({ state: "detached" });
  await page.mouse.up();
  await page.evaluate(() => window.save());
  await page.reload();
  await image.waitFor();
  assert.equal(await origin.count(), 0, "the media remains the only presentation after reopening");
  await page.mouse.move(blank.x, blank.y);
  await media.hover();
  await origin.waitFor();
  assert.ok((await origin.boundingBox()).x + (await origin.boundingBox()).width <= (await media.boundingBox()).x);

  const resize = media.getByRole("button", { name: "调整素材大小", exact: true });
  assert.equal(await resize.evaluate(el => getComputedStyle(el).opacity), "1", "hover reveals the shared lower-right square");
  await page.mouse.move(blank.x, blank.y);
  await origin.waitFor({ state: "detached" });
  await media.evaluate(() => document.activeElement.blur());
  assert.equal(await resize.evaluate(el => getComputedStyle(el).opacity), "0", "the square is hidden while idle");
  const previousSize = await media.boundingBox();
  assert.equal(previousSize.width, 274, "retain the existing non-default anchor width");
  const readStoredSize = () => page.evaluate(() => {
    const { width, height } = window.snapshot().nodes.find(node => node.id === "generation-session");
    return { width, height };
  });
  const writeCount = () => page.evaluate(() => window.calls.filter(call => call.command === "project_canvas_node_update"
    && call.args.nodeId === "generation-session").length);
  const stored = await readStoredSize();
  const writes = await writeCount();
  assert.notEqual(previousSize.height, stored.height, "visible height comes from the selected result ratio");
  // A click must neither write the derived height nor open the preview.
  await resize.click();
  assert.equal(await writeCount(), writes);
  assert.deepEqual(await readStoredSize(), stored);
  assert.equal(await preview.count(), 0);

  async function startResize(width, height) {
    const handle = await resize.boundingBox();
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + width, y + height, { steps: 4 });
  }
  const ratio = previousSize.height / previousSize.width;
  const assertResized = async (increase) => {
    const rect = await media.boundingBox();
    assert.equal(rect.x, previousSize.x);
    assert.equal(rect.y, previousSize.y);
    assert.ok(Math.abs(rect.width - previousSize.width - increase) < 1);
    assert.ok(Math.abs(rect.height - rect.width * ratio) < 1);
  };
  await startResize(72, 30);
  await assertResized(72);
  await page.waitForTimeout(220);
  assert.equal(await peek.count(), 0, "resizing does not mount a generator Peek");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await assertResized(0);
  assert.equal(await writeCount(), writes);
  assert.deepEqual(await readStoredSize(), stored);

  await startResize(85, 30);
  await page.mouse.up();
  await assertResized(85);
  await page.waitForFunction(() => window.snapshot().nodes.find(node => node.id === "generation-session")?.width === 359);
  assert.equal(await preview.count(), 0);
  assert.equal(await resize.evaluate(el => el === document.activeElement), true);
  await page.keyboard.press(`${modifier}+z`);
  await page.waitForFunction(expected => {
    const node = window.snapshot().nodes.find(node => node.id === "generation-session");
    return node?.width === expected.width && node.height === expected.height;
  }, stored);
  await assertResized(0);

  await startResize(95, 46);
  await page.mouse.up();
  await page.waitForFunction(() => window.snapshot().nodes.find(node => node.id === "generation-session")?.width === 369);
  await captureThemes("resized-generated-material");
  await page.evaluate(() => window.save());
  await page.reload();
  await image.waitFor();
  await assertResized(95);
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    snapshot.view = { ...snapshot.view, zoom: 0.3 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await page.reload();
  await image.waitFor();
  await page.mouse.move(blank.x, blank.y);
  await media.hover();
  await page.waitForTimeout(200);
  assert.equal(await origin.count(), 0, "zoom below 35% keeps the editor hidden");
  assert.deepEqual(errors, []);
  console.log("PASS original placement, live wires, hover bridge, Peek animation and reduced motion, high layers, anchor drag/undo, pinning, generated material resize/cancel/undo/reload and exact continuation");
  for (const kind of ["first", "peek", "pin", "pin-failure"]) {
    await runningSurvivesCanvasEdits(kind);
    console.log(`PASS ${kind}: generation DOM and running border survive unrelated canvas edits until the current result or failure`);
  }
  for (const type of ["material", "workflow", "library", "rapid"]) {
    await dragMustNotPeek(type);
    console.log(`PASS ${type}: suppress Peek throughout the drag and on release, then restore hover and click`);
  }
  await reconnectImageResult();
  console.log("PASS folded image target: hover, single and multi-image input, text input, thumbnails, focus, duplicate/self/cycle rejection");
  await reconnectWithMenuAndUndo();
  console.log("PASS folded target menu deduplicates the result and Ctrl/Cmd+Z undoes the connection without moving focus first");
  await rejectConnectionWhileGenerationIsPending();
  console.log("PASS submitted generation still rejects inputs while its completed workflow step waits for the result");
  for (const kind of ["remote", "remote-frames", "h3-r2v", "h3-frames"]) {
    await reconnectVideoResult(kind);
    console.log(`PASS ${kind} folded result links images and mode-compatible video references, then pins and focuses the source card`);
  }
  assert.deepEqual(errors, []);
} catch (error) {
  console.error("Canvas fixture", await page.evaluate(() => ({
    path: location.pathname,
    canvasNodes: Array.from(document.querySelectorAll("[data-canvas-node-id]"), node => node.getAttribute("data-canvas-node-id")).slice(0, 12),
    ipcMock: typeof window.store !== "undefined",
    firstSnapshotNodes: window.snapshot?.().nodes.slice(0, 4).map(node => node.id),
  })).catch(() => null), errors);
  throw error;
} finally {
  if (host) await host.close();
  else await browser.close();
  await server.close();
}
