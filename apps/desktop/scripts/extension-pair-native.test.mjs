import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

// Load a real unpacked extension in a fresh profile. Only the fixture socket
// address differs from the canonical package. Never connect to the user's app.
const root = resolve(".tmp/video-extension-native", "browser-" + Date.now());
const ext = join(root, "extension");
const legacy = process.env.BOWERBIRD_TEST_LEGACY_EXTENSION;
await mkdir(root, { recursive: true });
await cp(resolve("../extension"), ext, {recursive:true});
await mkdir(join(root,"appdata"));
await mkdir(join(root,"localappdata"));
await writeFile(join(root,"isolated-fixture"),"browser pairing fixture");
const script = join(ext,"collection-utils.js");
const original = await readFile(script,"utf8");
const pairingScript = join(ext,"pairing.js");
const originalPairing = await readFile(pairingScript,"utf8");
const endpoint = async url => {
  await writeFile(script,original.replaceAll("ws://127.0.0.1:39871/ws",url));
  await writeFile(pairingScript,originalPairing.replace("http://127.0.0.1:39871/pairing-session",
    url.replace("ws:", "http:").replace("/ws", "/pairing-session")));
};
const launch = () => chromium.launchPersistentContext(join(root,"profile"), {
  channel: "chromium", headless: true, executablePath: process.env.BOWERBIRD_TEST_CHROMIUM,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const http = createServer((_,res)=>{
  res.setHeader("Content-Type","text/html");
  res.end('<canvas id="sample" width="64" height="64"></canvas><script>sample.getContext("2d").fillRect(0,0,64,64)</script>');
});
await new Promise(done=>http.listen(0,"127.0.0.1",done));
let context, child;
async function waitFile(name) {
  for (let i=0; i<200 && child.exitCode===null; i++) {
    try { return JSON.parse(await readFile(join(root,name),"utf8")); } catch { await delay(50); }
  }
  throw new Error("Missing native fixture output: "+name);
}
try {
  child = spawn(resolve("src-tauri/target/debug/examples/collect_video_smoke.exe"),[],{
    windowsHide:true,stdio:"ignore",
    env:{...process.env,APPDATA:join(root,"appdata"),LOCALAPPDATA:join(root,"localappdata"),BOWERBIRD_COLLECT_TEST_ROOT:root},
  });
  const exited = new Promise((done,reject)=>{child.once("exit",done);child.once("error",reject);});
  const socketUrl=(await waitFile("address.json")).url;
  if (legacy) {
    const manifest=JSON.parse(await readFile(join(legacy,"manifest.json"),"utf8"));
    assert.equal(manifest.version,"0.3.1");
    await cp(legacy,ext,{recursive:true});
    for (const name of ["content.js","collection-utils.js","background.js"]) {
      const file=join(ext,name);
      await writeFile(file,(await readFile(file,"utf8")).replaceAll("ws://127.0.0.1:39871/ws",socketUrl));
    }
  } else await endpoint(socketUrl);
  context = await launch();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker",{timeout:10000});
  const optionsUrl=new URL("options.html",worker.url()).href;
  if (legacy) {
    assert.equal(await worker.evaluate(()=>chrome.runtime.getManifest().version),"0.3.1");
    // Chrome for Testing requires developer mode to reload an unpacked install.
    if (!await worker.evaluate(()=>navigator.userAgent.includes("Edg/"))) {
      const manager=await context.newPage();
      await manager.goto("chrome://extensions/");
      const developerMode=manager.locator("extensions-toolbar #devMode");
      if (!await developerMode.evaluate(el=>el.checked)) await developerMode.click();
      await manager.close();
    }
    await cp(resolve("../extension"),ext,{recursive:true});
    await endpoint(socketUrl);
    const stopped=worker.waitForEvent("close",{timeout:10000});
    await worker.evaluate(()=>{setTimeout(()=>chrome.runtime.reload(),0);});
    await stopped;
  }
  const options = await context.newPage();
  for (let attempt=0; attempt<50; attempt++) {
    try {
      await options.goto(optionsUrl);
      if (await options.evaluate(()=>chrome.runtime.getManifest().version==="0.5.1")) break;
    } catch { /* The unpacked extension is still reloading. */ }
    await delay(100);
  }
  assert.equal(await options.evaluate(()=>chrome.runtime.getManifest().version),"0.5.1");
  await options.waitForFunction(()=>document.querySelector("#code")?.value.length===97);
  const code = await options.locator("#code").inputValue();
  await context.close();
  await writeFile(join(root,"pending-pair.txt"),code);
  await rename(join(root,"pending-pair.txt"),join(root,"fixture-pair.txt"));
  await waitFile("ready.json");
  context = await launch();
  const page=await context.newPage();
  await page.goto(`http://127.0.0.1:${http.address().port}/`);
  const entry=page.getByRole("button",{name:"Bowerbird 采集菜单",exact:true});
  await entry.waitFor();
  await entry.evaluate(el=>el.click());
  assert.equal(await page.locator("#__bowerbird_confirm").count(),0);
  await entry.click();
  await page.getByRole("menuitem",{name:"设置",exact:true}).click();
  await page.getByRole("dialog",{name:"Bowerbird 设置"}).waitFor();
  await page.waitForFunction(()=>document.querySelector("#__bowerbird_pairing_code")?.textContent.length===97);
  assert.equal(await page.locator("#__bowerbird_pairing_code").evaluate(el=>el.textContent),code);
  await page.keyboard.press("Escape");
  const db=new DatabaseSync(join(root,"library.db"),{readOnly:true});
  const idle = {};
  try {
    for (const table of ["assets","analyses","task_queue","local_label_jobs"]) {
      idle[table]=db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      assert.equal(idle[table],0);
    }
  } finally {db.close();}
  await page.locator("#sample").click({modifiers:["Alt"]});
  const feedback=page.locator("#__bowerbird_toast");
  await feedback.filter({hasText:/采集结束/}).waitFor({timeout:15000});
  assert.match(await feedback.textContent(),/已保存 1 张（共 1 张）/);
  await writeFile(join(root,"stop"),"done");
  assert.equal(await exited,0);
  const result=JSON.parse(await readFile(join(root,"result.json"),"utf8"));
  assert.equal(result.members.length,1);
  assert.equal(result.members[0].width,64);
  const browserInfo=await (await context.newCDPSession(page)).send("Browser.getVersion");
  await writeFile(join(root,"verification.json"),JSON.stringify({browser:browserInfo.userAgent,upgradedFrom:legacy?"0.3.1":null,idle,members:result.members.length},null,2));
  console.log("PASS real unpacked extension options, persisted key after browser restart, signed page upload and native SQLite membership");
} finally {
  if(child && child.exitCode===null) child.kill();
  await context?.close();
  await new Promise(done=>http.close(done));
}
