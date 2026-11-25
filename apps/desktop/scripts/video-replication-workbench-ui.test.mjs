import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const directory = ".tmp/video-replication/tasks";
await mkdir(directory,{recursive:true});
execFileSync(process.env.BOWERBIRD_FFMPEG_BINARY || resolve("../../Windows/.work/.tmp/video-integration/tools/local/ffmpeg.exe"),
  ["-v","error","-y","-f","lavfi","-i","color=red:s=320x180:r=25:d=2","-c:v","libx264","-pix_fmt","yuv420p",directory + "/video.mp4"]);
const entry = "scripts/fixtures/canvas-reference/preview.html";
const server = await createServer({cacheDir:directory+"/vite",optimizeDeps:{entries:[entry]},
  server:{host:"127.0.0.1",port:1697,strictPort:false,hmr:false,watch:null}});
await server.listen();
const browser = await chromium.launch({channel:"chrome",headless:true});
try {
  const page = await browser.newPage({viewport:{width:1450,height:940}});
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/*",route=>new URL(route.request().url()).hostname==="127.0.0.1"?route.continue():route.abort());
  await page.goto(server.resolvedUrls.local[0]+entry+"?strict");
  const button = (parent,name)=>parent.getByRole("button",{name,exact:true});
  await button(page,"工具箱").waitFor();
  await page.evaluate(path=>{
    const ipc=window.__TAURI_INTERNALS__.invoke;
    const asset={id:"fetched",name:"采集样片.mp4",source:"imported",ext:"mp4",duration:2,store_path:"/"+path+"/video.mp4"};
    const tasks=[{id:"manual",kind:"douyin",state:"ready",sourceUrl:"手动采集",autoSave:false}];
    let failSave=true;
    window.toolCalls=[];
    window.__TAURI_INTERNALS__.invoke=async(name,args={})=>{
      if(name==="video_collection" && args.projectId==="p"){
        const {action,data}=args;window.toolCalls.push({action,data});
        if(action==="list")return structuredClone(tasks);
        if(action==="create-douyin"){
          const task={id:"desktop-tool",projectId:"p",kind:"douyin",autoSave:true,state:"ready",sourceUrl:"采集测试",reference:{name:asset.name}};
          tasks.push(task);return structuredClone(task);
        }
        if(action==="save" && data.id==="desktop-tool"){
          if(failSave){failSave=false;throw Error("保存失败，请重试。");}
          tasks[1].assetId=asset.id;return asset;
        }
        throw Error("采集动作无效");
      }
      if(name==="video_replication"){
        window.toolCalls.push({action:args.action,data:args.data});
        if(args.action==="case-list")return [{id:"archive",title:"旧项目分镜",analysisText:"历史画面",enhancedId:"old",sourceMethod:"local"}];
        if(args.action==="enhanced-read")return {slices:[{index:0,start:0,end:2}],prompts:[{index:0,prompt:"旧镜头的提示词"}]};
        throw Error("旧工作台产生额外操作");
      }
      if(name==="get_assets_by_ids" && args.assetIds.includes(asset.id))return [asset];
      if(name==="video_shots_get")return {sourceHash:"version",durationMs:2000,revision:1,threshold:.35,cuts:[],selected:[],results:{},canUndo:false,undoCuts:null};
      if(name==="video_shots_progress")return {status:"idle",remaining:[],stopping:false,error:null};
      if(name==="video_shots_frame")return "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
      return ipc(name,args);
    };
  },directory);
  async function openTool(){
    await button(page,"工具箱").click();
    await page.getByRole("menuitem",{name:/抖音视频采集/}).click();
    const dialog=page.getByRole("dialog",{name:"抖音视频采集",exact:true});await dialog.waitFor();return dialog;
  }
  let dialog=await openTool();
  await button(dialog,"历史复刻记录").click();
  await button(page,"旧项目分镜").click();
  const archive=page.getByRole("region",{name:"只读记录"});
  await archive.getByText("旧镜头的提示词",{exact:true}).waitFor();
  assert.equal(await archive.locator("input,textarea,[contenteditable=true]").count(),0);
  await button(page,"返回").click();await button(page,"返回").click();
  dialog=page.getByRole("dialog",{name:"抖音视频采集",exact:true});
  assert.equal(await dialog.getByText("手动采集").count(),0);
  await dialog.getByRole("textbox",{name:"视频链接"}).fill("https://v.douyin.com/fixture/");
  await button(dialog,"解析并下载入库").click();
  await dialog.getByRole("alert").waitFor();
  await page.waitForFunction(()=>window.toolCalls.filter(c=>c.action==="list").length>=3);
  assert.equal(await page.evaluate(()=>window.toolCalls.filter(c=>c.action==="save").length),1);
  await button(dialog,"保存到素材库").click();
  await button(dialog,"打开复刻").click();
  const panel=page.getByRole("dialog",{name:"视频分析工作区"}).getByRole("region",{name:"复刻",exact:true});
  await panel.getByText("镜头 01",{exact:true}).first().waitFor();
  assert.deepEqual(await page.evaluate(()=>window.toolCalls.filter(c=>c.action==="save").map(c=>c.data.id)),["desktop-tool","desktop-tool"]);
  assert.deepEqual(errors,[]);
  console.log("PASS toolbox capture, read-only historical case and enhanced shots, opt-in auto-save, bounded failure/retry, direct asset replication");
} finally {await browser.close();await server.close();}
