import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
import { startBrowserDrag, finishBrowserDrag } from "./fixtures/explorer/native-drag.mjs";

const output = ".tmp/explorer-selection";
await mkdir(output, { recursive: true });
const sources = await Promise.all([
  "../extension/candidate-utils.js", "src/lib/explorerDragVisual.js", "src-tauri/src/commands/source_browser_drag.js",
].map(file => readFile(file, "utf8")));
const paragraph = "这里是小红书笔记正文，可以拖选复制文字与继续阅读。图片和文字应该各自保持原来的操作方式。";
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#326488"/></svg>';
const video = await readFile("src-tauri/tests/fixtures/media/fragmented.mp4");

function fixture(kind) {
  const backdrop = kind === "backdrop";
  const cardText = kind === "card-text" || kind === "selected-text";
  const edgeCard = ["video-fallback", "pointer-none-opaque-base", "pointer-none-title", "overlay-outside-text", "link-overlay", "opacity-zero-overlay"].includes(kind);
  return `<meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;font:18px/28px Arial,"Microsoft Yahei",sans-serif}
    #background{position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;z-index:0}
    #backdrop{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:10;user-select:none}
    #note{position:fixed;left:180px;top:80px;width:720px;height:520px;padding:30px;background:#fff;z-index:20;display:flex;gap:30px}
    #picture{position:relative;width:280px;height:360px;flex:none}
    #picture img,#swipe{position:absolute;inset:0;width:280px;height:360px}
    #text{margin:0;width:330px;user-select:text}
    #card{position:absolute;left:180px;top:80px;width:560px;height:360px}
    #card img{width:100%;height:100%;object-fit:cover}
    #card #text{position:absolute;left:22px;top:45px;background:rgba(255,255,255,.92);padding:12px;width:420px}
    #drop{position:fixed;right:20px;bottom:20px;width:140px;height:100px;background:#ddd;z-index:30}
    #edge-card{position:absolute;left:180px;top:80px;width:360px;height:430px}
    #edge-image,#edge-video,#edge-mask,#opaque-base{position:absolute;left:0;top:60px;width:280px;height:300px}
    #opaque-base{background:#314253;z-index:0}#edge-image,#edge-video{z-index:1}#edge-mask{z-index:2}
    ${kind === "overlay-outside-text" ? "#edge-mask{background:rgba(255,255,255,0)}" : ""}
    ${kind === "opacity-zero-overlay" ? "#edge-mask{background:linear-gradient(#fff,#314253);opacity:0}" : ""}
  </style>
  ${edgeCard ? `<div id="edge-card">${kind === "pointer-none-title" || kind === "overlay-outside-text" ? "图外标题文字位于卡片顶部" : ""}
    ${kind === "video-fallback" ? '<video id="edge-video" src="/clip.mp4" poster="/poster.png" preload="metadata" draggable="false">浏览器不支持此视频的后备文字</video>' : `
      ${kind === "pointer-none-opaque-base" ? '<div id="opaque-base"></div>' : ""}
      <img id="edge-image" src="/edge.png" draggable="false" ${kind.startsWith("pointer-none") ? 'style="pointer-events:none"' : ""}>
      ${kind === "link-overlay" ? '<a id="edge-mask" href="/pin/42"></a>' : kind === "pointer-none-opaque-base" || kind === "overlay-outside-text" || kind === "opacity-zero-overlay" ? '<div id="edge-mask"></div>' : ""}`}
    </div>` : cardText ? `<div id="card"><img id="background" src="/background.png" draggable="false"><p id="text"><span id="text-span">${paragraph}</span></p></div>` : `
    <img id="background" src="/background.png" draggable="false">
    ${backdrop ? '<div id="backdrop"></div>' : ""}
    <section id="note" ${kind === "dialog-text" ? 'role="dialog" aria-modal="true"' : ""}>
      <div id="picture">${kind === "carousel" ? '<img id="old-slide" src="/old.png" style="opacity:0" draggable="false">' : ""}
        <img id="note-image" src="/note.png" srcset="/note.png 1x, /note-large.png 2x" draggable="false">
        ${kind === "carousel" ? '<div id="swipe"></div>' : ""}
      </div><p id="text"><span id="text-span">${paragraph}</span></p>
    </section>`}
  <div id="drop">Drop</div>`;
}

async function createPage(browser, kind) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await page.addInitScript(() => {
    window.notices = [];
    window.open = url => { window.notices.push(String(url)); return null; };
    window.addEventListener("pointerdown", event => { window.lastPointerTarget = event.target; }, true);
  });
  for (let index = 0; index < sources.length; index++) {
    await page.addInitScript(index === 2 ? sources[index].replace("__BOWERBIRD_DRAG_BRIDGE__", "bowerbird-explorer://selection-test") : sources[index]);
  }
  await page.route("https://selection.test/**", route => route.fulfill(new URL(route.request().url()).pathname === "/clip.mp4"
    ? {contentType:"video/mp4",body:video}
    : route.request().resourceType() === "image"
    ? {contentType: "image/svg+xml", body: svg}
    : {contentType: "text/html; charset=utf-8", body: fixture(kind)}));
  await page.goto("https://selection.test/");
  await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
  await page.evaluate(() => {
    const drop = document.querySelector("#drop");
    drop.addEventListener("dragover", event => event.preventDefault());
    drop.addEventListener("drop", event => { event.preventDefault(); window.dropData = event.dataTransfer.getData("application/x-bowerbird-explorer"); });
  });
  return page;
}

async function pointerGesture(page, start, end) {
  const session = await page.context().newCDPSession(page);
  const intercepted = [];
  session.on("Input.dragIntercepted", ({data}) => intercepted.push(data));
  await session.send("Input.setInterceptDrags", { enabled: true });
  try {
    await session.send("Input.dispatchMouseEvent", {type:"mouseMoved",x:start.x,y:start.y});
    await session.send("Input.dispatchMouseEvent", {type:"mousePressed",x:start.x,y:start.y,button:"left",buttons:1,clickCount:1});
    const pressed = await page.evaluate(() => ({
      target: window.lastPointerTarget.id, draggable: window.lastPointerTarget.getAttribute("draggable"),
      userDrag: window.lastPointerTarget.style.getPropertyValue("-webkit-user-drag"),
    }));
    for (let step=1;step<=12;step++) await session.send("Input.dispatchMouseEvent", {
      type:"mouseMoved", x:start.x+(end.x-start.x)*step/12, y:start.y+(end.y-start.y)*step/12, button:"left", buttons:1,
    });
    await page.waitForTimeout(80);
    if (intercepted.length) await session.send("Input.dispatchDragEvent", {type:"dragCancel",x:end.x,y:end.y,data:intercepted.at(-1)});
    await session.send("Input.dispatchMouseEvent", {type:"mouseReleased",x:end.x,y:end.y,button:"left",buttons:0,clickCount:1});
    return { pressed, drags:intercepted, ...await page.evaluate(() => ({selection:String(window.getSelection()), notices:window.notices})) };
  } finally { await session.detach(); }
}

function assertNoCapture(result, name) {
  assert.equal(result.pressed.draggable, null, `${name}: pointerdown must not turn text/backdrop into a drag handle; ${JSON.stringify(result.pressed)}`);
  assert.equal(result.pressed.userDrag, "", `${name}: selection must not be overridden by element dragging`);
  assert.equal(result.notices.filter(url => new URL(url).pathname === "/start").length, 0, `${name}: no private capture start`);
  assert.equal(result.drags.some(drag => drag.items.some(item => item.mimeType === "application/x-bowerbird-explorer" || item.data.startsWith("bowerbird-explorer:"))), false, `${name}: browser drag must not carry image capture data`);
}

const cases = ["dialog-text", "fixed-text", "card-text", "selected-text", "backdrop", "background-image", "note-image", "carousel",
  "video-fallback", "pointer-none-opaque-base", "pointer-none-title", "note-blank", "overlay-outside-text", "link-overlay", "opacity-zero-overlay"];
const results = [];
const browser = await chromium.launch({channel:"chrome",headless:true});
try {
  for (const kind of cases) {
    const page = await createPage(browser, kind);
    try {
      if (["background-image","note-image","carousel","video-fallback","pointer-none-opaque-base","pointer-none-title","overlay-outside-text","link-overlay","opacity-zero-overlay"].includes(kind)) {
        const point = kind === "background-image" ? {x:60,y:120} : {x:300,y:220};
        const {session,data} = await startBrowserDrag(page, point.x, point.y);
        await finishBrowserDrag(session, data, 1010, 690);
        const payload = await page.evaluate(() => JSON.parse(window.dropData));
        const expectedImage = kind === "background-image" ? "background.png"
          : kind === "video-fallback" ? "clip.mp4"
          : kind.startsWith("pointer-none") || kind === "overlay-outside-text" || kind === "link-overlay" || kind === "opacity-zero-overlay" ? "edge.png" : "note-large.png";
        assert.equal(payload.imageUrl, `https://selection.test/${expectedImage}`);
        assert.equal(payload.pageUrl, kind === "link-overlay" ? "https://selection.test/pin/42" : "https://selection.test/", "source page preserves the overlay link destination");
        if (kind === "video-fallback") assert.equal(payload.mediaKind, "video", "invisible video fallback text is not visible article text");
        assert.equal((await page.evaluate(() => window.notices)).filter(url => new URL(url).pathname === "/start").length, 1);
      } else {
        const rect = await page.locator(kind === "backdrop" ? "#backdrop" : kind === "note-blank" ? "#note" : "#text-span").boundingBox();
        const start = kind === "backdrop" ? {x:60,y:140} : kind === "note-blank" ? {x:220,y:560} : {x:rect.x+8,y:rect.y+12};
        if (kind === "selected-text") {
          await page.mouse.click(start.x, start.y, {clickCount:3});
          assert.ok((await page.evaluate(() => String(window.getSelection()))).includes("小红书"), "native triple click selects paragraph text");
        }
        const result = await pointerGesture(page, start, {x:start.x+210,y:start.y+(kind === "selected-text" ? 70 : 0)});
        await writeFile(`${output}/${kind}.json`, JSON.stringify(result,null,2));
        assertNoCapture(result, kind);
        if (kind === "selected-text") {
          assert.ok(result.drags.some(drag => drag.items.some(item => item.mimeType === "text/plain" && item.data.includes("小红书"))), "selected text remains native text drag data");
        } else if (kind !== "backdrop" && kind !== "note-blank") {
          assert.ok(result.selection.length >= 5, `${kind}: mouse movement must select readable text, got ${JSON.stringify(result.selection)}`);
        }
      }
      results.push({kind,ok:true}); console.log(`PASS ${kind}`);
    } catch(error) { results.push({kind,ok:false,error:String(error)}); console.error(`FAIL ${kind}: ${error}`); }
    finally { await page.close(); }
  }
} finally { await browser.close(); }
await writeFile(`${output}/results.json`, JSON.stringify(results,null,2));
assert.equal(results.filter(result => !result.ok).length, 0, "explorer selection/drag behavior regressions");
