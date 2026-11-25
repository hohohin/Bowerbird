import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1564, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = []; page.on("pageerror", e => errors.push(e.message));
const dialog = page.getByRole("dialog", { name: "草稿编辑器", exact: true });
const button = name => dialog.getByRole("button", { name, exact: true });
const field = name => dialog.getByLabel(name, { exact: true });
const canvas = () => dialog.locator("[data-draft-canvas]");
const png = () => canvas().evaluate(c => c.toDataURL());
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function configureCanvas(width, height, transparent) {
  await button("裁剪").click();
  await field("裁剪比例").selectOption("free");
  await field("裁剪宽度").fill(String(width)); await field("裁剪高度").fill(String(height));
  await button("应用裁剪").click(); await settle();
  const toggle = button(`${transparent ? "隐藏" : "显示"} 背景`);
  if (await toggle.count()) await toggle.click();
  await button("画笔").click(); await settle();
}
async function openDefault() {
  await page.evaluate(() => window.openDraft());
  await canvas().waitFor(); await settle();
  assert.deepEqual(await canvas().evaluate(c => [c.width, c.height]), [1600, 1200], "new draft opens directly at its default document size");
  assert.deepEqual(await pixel(0, 0), [255, 255, 255, 255], "default white background renders under StrictMode before any input");
  assert.equal(await dialog.locator(".draft-canvas-settings").count(), 0, "canvas sizing belongs to crop controls, not sidebar settings");
  assert.equal(await button("创建画布").count(), 0, "new draft has no preliminary creation form");
  assert.equal(await button("保存工程").isDisabled(), true);
  assert.equal(await button("撤销").isDisabled(), true);
}
async function create(transparent = true) {
  await openDefault();
  await configureCanvas(640, 480, transparent);
}
async function point(x, y) {
  const box = await canvas().boundingBox();
  const dims = await canvas().evaluate(c => ({ width: c.width, height: c.height }));
  return { x: box.x + x / dims.width * box.width, y: box.y + y / dims.height * box.height };
}
async function draw(tool, x1, y1, x2, y2) {
  await button(tool).click();
  const a = await point(x1, y1), b = await point(x2, y2);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up(); await settle();
}
async function pixel(x, y) { await settle(); return canvas().evaluate((c, [x,y]) => Array.from(c.getContext("2d").getImageData(x,y,1,1).data), [x,y]); }
async function discard() {
  await button("关闭草稿").click();
  const confirm = page.getByRole("alertdialog");
  if (await confirm.count()) await confirm.getByRole("button", { name: "放弃修改" }).click();
  await dialog.waitFor({ state: "hidden" });
}
try {
  await page.goto("http://127.0.0.1:1564/scripts/fixtures/draft-editor/preview.html");
  await openDefault();
  await draw("画笔", 120, 120, 300, 120);
  assert.deepEqual(await pixel(200, 120), [34, 34, 34, 255], "default document draws immediately without opening settings");
  const defaultPainted = await png();
  await configureCanvas(640, 480, false);
  assert.deepEqual(await pixel(200, 120), [34, 34, 34, 255], "changing document size preserves existing pixels at document coordinates");
  const smaller = await png();
  await configureCanvas(800, 600, false);
  assert.deepEqual(await canvas().evaluate(c => [c.width, c.height]), [800, 600]);
  assert.deepEqual(await pixel(740, 540), [255, 255, 255, 255], "expanded white canvas fills the new document area");
  await field("前景颜色").fill("#e63322");
  await draw("画笔", 690, 540, 780, 540);
  assert.deepEqual(await pixel(740, 540), [230, 51, 34, 255], "drawing layer reaches newly expanded canvas area");
  await button("撤销").click(); await settle();
  assert.deepEqual(await pixel(740, 540), [255, 255, 255, 255], "new-area stroke has its own undo entry");
  await button("撤销").click(); await settle();
  assert.deepEqual(await canvas().evaluate(c => [c.width, c.height]), [640, 480], "canvas settings undo restores previous dimensions");
  assert.equal(await png(), smaller, "canvas settings undo restores exact old pixels");
  await button("重做").click(); await settle();
  assert.deepEqual(await canvas().evaluate(c => [c.width, c.height]), [800, 600], "canvas settings redo restores expanded dimensions");
  await button("撤销").click(); await button("撤销").click(); await settle();
  assert.equal(await png(), defaultPainted, "undoing both size changes returns to the original default canvas and stroke");
  await discard();

  await create();
  const blank = await png();
  const settingsCanUndo = await button("撤销").isEnabled();
  await button("放大视图").click(); await button("缩小视图").click(); await button("适应窗口").click();
  assert.equal(await png(), blank, "view buttons never draw pixels");
  assert.equal(await button("撤销").isEnabled(), settingsCanUndo, "view buttons do not change history availability");
  const viewBox = await dialog.locator(".draft-view-tools").boundingBox();
  assert.ok(viewBox.height < 60, "zoom toolbar is compact");
  const stageBefore = await dialog.locator(".draft-stage").getAttribute("style");
  const p = await point(300,250);
  await dialog.locator(".draft-preview").focus(); await page.keyboard.down("Space");
  await page.mouse.move(p.x,p.y); await page.mouse.down(); await page.mouse.move(p.x + 60,p.y + 30); await page.mouse.up(); await page.keyboard.up("Space");
  assert.notEqual(await dialog.locator(".draft-stage").getAttribute("style"), stageBefore, "Space pan binds after setup");
  assert.equal(await png(), blank); await button("适应窗口").click();
  await page.mouse.move(p.x,p.y); await page.mouse.wheel(0,-100); await settle();
  assert.notEqual(await dialog.locator(".draft-stage").getAttribute("style"), stageBefore, "wheel binds after setup");
  await button("适应窗口").click();
  await field("画笔大小").fill("1"); await draw("箭头",100,300,200,300);
  assert.ok((await pixel(190,293))[3]>0,"thin arrows keep the entire arrowhead");
  await button("撤销").click(); await settle(); assert.equal(await png(),blank);

  await field("前景颜色").fill("#e63322"); await field("画笔大小").fill("30");
  await draw("画笔", 80,100,540,100);
  assert.deepEqual((await pixel(250,100)).slice(0,3), [230,51,34]);
  const painted = await png();
  await button("撤销").click(); await settle(); assert.equal(await png(), blank);
  await button("重做").click(); await settle(); assert.equal(await png(), painted);
  await draw("橡皮",300,60,300,140); assert.equal((await pixel(300,100))[3],0, "eraser creates transparent pixels");
  await button("撤销").click(); await settle(); assert.equal(await png(),painted);
  await button("画笔").click();
  const cancelPoint = await point(300,300);
  await page.mouse.move(cancelPoint.x,cancelPoint.y); await page.mouse.down(); await page.mouse.move(cancelPoint.x+30,cancelPoint.y+20);
  await page.keyboard.press("Escape"); await page.mouse.up(); await settle(); assert.equal(await png(),painted,"Escape rolls back active stroke");
  await page.mouse.move(cancelPoint.x,cancelPoint.y); await page.mouse.down(); await page.mouse.move(cancelPoint.x+30,cancelPoint.y+20);
  await page.evaluate(() => window.dispatchEvent(new Event("blur"))); await page.mouse.up(); await settle(); assert.equal(await png(),painted,"window blur rolls back active stroke");

  await draw("选区",50,200,180,300); await button("填充选区").click();
  assert.equal((await pixel(100,250))[3],255); assert.equal((await pixel(200,250))[3],0);
  const filled = await png(); await field("前景颜色").fill("#2266cc"); await button("画笔").click();
  const activePoint = await point(100,250); await page.mouse.move(activePoint.x,activePoint.y); await page.mouse.down();
  await page.mouse.move(activePoint.x+30,activePoint.y+10); await page.keyboard.press("Delete"); await page.mouse.up();
  assert.equal((await pixel(100,250))[3],0,"Delete first cancels the active stroke then clears selection");
  await button("撤销").click(); await settle(); assert.equal(await png(),filled,"clear undo excludes half-finished stroke");
  await button("撤销").click(); await settle(); assert.equal(await png(),painted,"second undo reaches the pre-fill document");
  await button("重做").click(); await field("前景颜色").fill("#e63322");
  await draw("选区",50,200,180,300);
  await draw("画笔",30,250,220,250); assert.equal((await pixel(200,250))[3],0,"brush clips to selection");
  await dialog.locator(".draft-preview").focus(); await page.keyboard.press("Delete"); assert.equal((await pixel(100,250))[3],0);
  await button("取消选区").click();
  await button("裁剪").click();
  const nw = await point(0,0), cropA = await point(40,40);
  await page.mouse.move(nw.x,nw.y); await page.mouse.down(); await page.mouse.move(cropA.x,cropA.y,{steps:5}); await page.mouse.up();
  const se = await point(640,480), cropB = await point(600,440);
  await page.mouse.move(se.x,se.y); await page.mouse.down(); await page.mouse.move(cropB.x,cropB.y,{steps:5}); await page.mouse.up();
  await button("应用裁剪").click();
  const cropped = await canvas().evaluate(c => [c.width,c.height]);
  assert.deepEqual(cropped,[560,400]); await button("撤销").click(); await settle();
  assert.deepEqual(await canvas().evaluate(c => [c.width,c.height]),[640,480]);
  await button("移动").click();
  await field("位置 X").fill("20"); await field("位置 Y").click(); await settle();
  assert.equal((await pixel(90,100))[3],255,"numeric move applies to composite");
  await field("图层宽度").fill("320"); await field("位置 Y").click(); await settle();
  assert.equal(await field("图层高度").inputValue(),"240","numeric resize preserves aspect");
  await button("复制图层").click(); assert.equal(await dialog.locator("[data-draft-layer]").count(),3);
  await button("删除图层").click(); await button("撤销").click(); assert.equal(await dialog.locator("[data-draft-layer]").count(),3);
  await dialog.locator(".draft-layer-select").filter({hasText:"副本"}).click();
  await button("图层下移").click(); await button("图层上移").click();
  await button("锁定 绘画图层 副本").click(); assert.equal(await field("图层名称").isDisabled(),true);
  await button("解锁 绘画图层 副本").click();
  await button("隐藏 绘画图层 副本").click(); await button("显示 绘画图层 副本").click();

  await button("文字").click(); const textPoint = await point(50,250); await page.mouse.click(textPoint.x,textPoint.y);
  await field("画布文字").fill("草稿 Hello\n第二行");
  await field("画布文字").press("Space");
  assert.match(await field("画布文字").inputValue(),/ /,"space stays text input");
  await field("画布文字").dispatchEvent("keydown",{ key:"Escape",code:"Escape",isComposing:true });
  assert.equal(await field("画布文字").count(),1,"IME Escape cannot exit text editing");
  await field("画布文字").press("Escape"); assert.equal(await field("画布文字").count(),0);
  await field("字号").fill("36"); await field("图层名称").click();
  await field("文字字体").selectOption("Arial"); await field("文字对齐").selectOption("center");
  await button("导出 PSD").click();
  await page.waitForFunction(() => window.exports.length === 1);
  const exported = await page.evaluate(() => window.exports[0]);
  assert.equal(Buffer.from(exported.base64,"base64").subarray(0,4).toString(),"8BPS");
  await button("关闭草稿").click(); const confirm = page.getByRole("alertdialog");
  await confirm.waitFor(); assert.equal(await page.evaluate(() => document.activeElement.textContent),"继续编辑");
  for(let i=0;i<6;i++) { await page.keyboard.press("Tab"); assert.equal(await page.evaluate(() => !!document.activeElement.closest('[role="alertdialog"]')),true); }
  await confirm.getByRole("button",{name:"继续编辑"}).click();
  await page.evaluate(() => { window.failSave = true; }); await button("保存工程").click();
  await dialog.getByRole("alert").waitFor();
  const attempts = await page.evaluate(() => window.calls.filter(c=>c.command==="draft_workspace_save"));
  assert.equal(attempts.length,1);
  await page.evaluate(() => { window.failSave = false; }); await button("保存工程").click(); await dialog.waitFor({state:"hidden"});
  const retry = await page.evaluate(() => window.calls.filter(c=>c.command==="draft_workspace_save"));
  assert.equal(retry[1].args.saveId,retry[0].args.saveId);
  const saved = await page.evaluate(() => window.saves[0]);
  assert.equal(saved.document.layers.length,4); assert.match(saved.document.layers[3].text.content,/草稿 Hello/);
  await page.reload(); await page.evaluate(() => window.openDraft("saved")); await canvas().waitFor(); await settle();
  assert.equal(await dialog.locator("[data-draft-layer]").count(),4);
  assert.equal(await png(), saved.dataUrl, "reopened draft paints its saved composite before any edit or view action");
  await button("编辑画布文字").click(); assert.match(await field("画布文字").inputValue(),/草稿 Hello/);
  await field("画布文字").press("Escape");
  await mkdir(".tmp/draft-editor",{recursive:true}); await page.screenshot({path:".tmp/draft-editor/light.png",animations:"disabled"});
  await page.evaluate(() => { document.documentElement.dataset.theme="dark"; }); await page.screenshot({path:".tmp/draft-editor/dark.png",animations:"disabled"});
  await page.setViewportSize({width:900,height:700}); await settle();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:".tmp/draft-editor/compact.png"}); await discard();

  await create();
  const imageUrl=await page.evaluate(() => { const c=document.createElement("canvas");c.width=80;c.height=60;const ctx=c.getContext("2d");ctx.fillStyle="#2266cc";ctx.fillRect(0,0,80,60);return c.toDataURL(); });
  await dialog.locator('input[type="file"]').setInputFiles({name:"pasted.png",mimeType:"image/png",buffer:Buffer.from(imageUrl.split(",")[1],"base64")});
  await button("隐藏 pasted").waitFor(); assert.equal(await dialog.locator("[data-draft-layer]").count(),3);
  assert.deepEqual((await pixel(320,240)).slice(0,3),[34,102,204]);
  await draw("选区",300,220,340,260);
  await page.evaluate(() => { window.delaySave=true; }); await button("保存工程").click();
  await page.waitForFunction(() => !!window.releaseSave);
  assert.equal(await button("填充选区").isDisabled(),true); assert.equal(await button("清除选区").count(),0);
  const busyPixels = await png(), busyLayers = await dialog.locator("[data-draft-layer]").count();
  await dialog.locator(".draft-preview").focus(); await page.keyboard.press("Delete"); await settle();
  assert.equal(await png(),busyPixels); assert.equal(await dialog.locator("[data-draft-layer]").count(),busyLayers);
  await page.evaluate(() => window.releaseSave()); await dialog.waitFor({state:"hidden"});
  assert.deepEqual(errors,[]);
  console.log("Draft editor UI passed under StrictMode: immediate default white canvas, resize/new-area painting/undo, view navigation, brush/erase/cancel, selection/crop, layers, text/IME, PSD, retry/reopen initial paint, import, busy guard, themes and compact layout.");
} finally { await browser.close(); await server.close(); }
