import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const source = await readFile(new URL("../src-tauri/src/codex/jimeng_web.js", import.meta.url), "utf8");
const resultSource = await readFile(new URL("../src-tauri/src/codex/jimeng_web_result.js", import.meta.url), "utf8");
const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome" });
try {
  const page = await browser.newPage();
  await page.setContent(`<section class="main-frame-2026"><div aria-label="提示词" contenteditable="true"></div>
    <div aria-label="创作类型">图片生成</div><div aria-label="模型">Seedream 5.5</div>
    <button aria-label="选择生成数量: 1">1张</button><button>9:16 2K</button>
    <div data-content-generator-references></div><button aria-label="生成">生成</button></section>
    <article data-generated-record-key="old"><span class="prompt-value-container-fixture">白色雏菊</span>
    <img alt="参考"><div role="button"><img data-apm-action="ai-generated-image-record-card"></div>
    <button aria-label="下载">下载</button></article>`);
  const count = await page.evaluate(async code => {
    const editor = document.querySelector("[contenteditable]");
    let downloads = 0, submissions = 0;
    document.querySelector("article button").onclick = () => { throw Error("selected old result"); };
    function picture(red) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 512;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = red; ctx.fillRect(0,0,512,512);
      return canvas.toDataURL();
    }
    document.querySelector("article img").src = picture("blue");
    const refs = document.querySelector("[data-content-generator-references]");
    refs.addEventListener("drop", event => {
      Array.from(event.dataTransfer.files).forEach((file, index) => {
        const slot = document.createElement("div");
        slot.dataset.index = String(index);
        const image = new Image();
        image.src = URL.createObjectURL(file);
        slot.append(image);
        refs.append(slot);
        const mention = document.createElement("span");
        mention.className = "node-referenceMentionTag";
        mention.contentEditable = "false";
        mention.textContent = file.name;
        editor.append(mention);
      });
    });
    document.querySelector('[aria-label="生成"]').onclick = () => {
      submissions++;
      const card = document.querySelector("article").cloneNode(true);
      card.dataset.generatedRecordKey = "new";
      card.querySelector("[data-apm-action]").src = picture("green");
      card.querySelector("button").remove();
      card.querySelector("[role=button]").addEventListener("mouseover", () => {
        const download = document.createElement("div");
        download.setAttribute("aria-label","下载");
        download.onclick = () => downloads++;
        card.append(download);
      }, {once:true});
      document.body.append(card);
    };
    const state = {};
    const request = {model:"Seedream 5.5",prompt:"白色雏菊",ratio:"9:16",files:["red","green"].map(color => ({name:color+".png",mime:"image/png",data:picture(color).split(",")[1]}))};
    const compose = (0,eval)(code);
    await compose(request, state);
    state.download();
    const slots = refs.children.length;
    refs.replaceChildren();
    refs.addEventListener("drop", () => refs.append(refs.firstElementChild.cloneNode(true)), {once:true});
    let duplicateError;
    try { await compose(request, {}); } catch (error) { duplicateError = error.message; }
    return { downloads, submissions, phase:state.phase, slots, duplicateError };
  }, resultSource + "\n(" + source + ")");
  assert.deepEqual(count, { downloads:1, submissions:1, phase:"download", slots:2, duplicateError:"ref-count" });
  console.log("Jimeng Web: selected references, single submission, same-prompt history, scoped download OK");
} finally {
  await browser.close();
}
