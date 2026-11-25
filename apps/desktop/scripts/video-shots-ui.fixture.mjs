import assert from "node:assert/strict";

// Exercise the production panel inside the same shared preview as the transcript and description.
async function installShotMock(page) {
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    const first = "0-1000", second = "1000-2000";
    const plan = {sourceHash:"current-original",revision:1,durationMs:2000,threshold:.35,
      cuts:[{at:1000,kind:"scene"}], selected:[first,second], results:{[first]:["画面","首帧","运镜"]},canUndo:false,undoCuts:null};
    let undo;
    let rerunning = false;
    let progress = {status:"idle",remaining:[],stopping:false,error:null};
    const receipts = new Map();
    window.__TAURI_INTERNALS__.invoke = async (name,args) => {
      if (!name.startsWith("video_shots_")) return original(name,args);
      window.calls.push({command:name,args});
      if (name === "video_shots_delivery_get") return receipts.get(args.deliveryKey) ?? null;
      if (name === "video_shots_frame_asset") return {id:"existing",name:"镜头首帧",width:320,height:180,ext:"jpg",store_path:"/frame.jpg",thumb_path:null};
      if (name === "video_shots_deliver") {
        const workflow = await original("canvas_workflow_get",{projectId:args.projectId});
        if (workflow.revision !== args.revision) throw Error("版本冲突");
        for (const frame of args.frames) await original("project_canvas_node_create",{value:frame});
        if (args.additions.length) {
          workflow.document.nodes.push(...args.additions);
          workflow.revision++;
          sessionStorage.setItem("workflow-"+args.projectId,JSON.stringify(workflow));
        }
        receipts.set(args.deliveryKey,args.focusId);
        window.emitFixtureEvent("project-canvas://nodes-changed",args.projectId);
        return args.focusId;
      }
      if (name === "video_shots_get") return structuredClone(plan);
      if (name === "video_shots_frame") return "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
      if (name === "video_shots_detect") return [];
      if (name === "video_shots_update") {
        const c = args.change;
        if (args.revision !== plan.revision || args.sourceHash !== plan.sourceHash) throw Error("请刷新方案");
        if (c.type === "cuts") {
          if (c.confirmed.join() !== first) throw Error("请确认清除镜头");
          undo = structuredClone(plan); plan.cuts = c.cuts; plan.results = {}; plan.selected = []; plan.canUndo = true; plan.undoCuts = undo.cuts;
        } else if (c.type === "undo") Object.assign(plan,undo,{revision:plan.revision});
        else if (c.type === "edit") plan.results[c.id] = c.texts;
        else if (c.type === "select") plan.selected = c.selected;
        plan.revision++; return structuredClone(plan);
      }
      if (name === "video_shots_quote") return {sourceHash:plan.sourceHash,owner:"test-owner",shotIds:args.shotIds,
        rerun:args.rerun,pricingVersion:7,totalMilli:54*args.shotIds.length,expiresAt:Date.now()+30000};
      if (name === "video_shots_progress") {
        if (progress.stopping) { plan.results[second] = ["新画面","新首帧","新运镜"]; plan.revision++; progress={status:"stopped",remaining:[],stopping:false,error:null}; }
        if (rerunning) { rerunning=false; plan.results[first]=["重跑画面","重跑首帧","重跑运镜"]; plan.revision++; progress={status:"completed",remaining:[],stopping:false,error:null}; }
        return structuredClone(progress);
      }
      if (name === "video_shots_start") { rerunning=args.quote.rerun; progress={status:"running",remaining:args.quote.shotIds,stopping:false,error:null}; }
      if (name === "video_shots_stop") progress.stopping=true;
      return structuredClone(progress);
    };
  });
}

export async function verifyShotPanel(page, workspace) {
  await installShotMock(page);
  const button = (parent,name) => parent.getByRole("button",{name,exact:typeof name==="string"});
  await button(workspace,"复刻").click();
  const region = workspace.getByRole("region",{name:"复刻",exact:true});
  const textbox = region.getByRole("textbox",{name:"首帧生图提示词",exact:true});
  await region.getByText("还有 1 个选中镜头未分析，请先分析或取消勾选").waitFor();
  await button(region,"查看镜头 2").click();
  await page.waitForFunction(()=>Math.abs(document.querySelector('.is-video-analysis video').currentTime-1)<0.04);
  await button(region,"查看镜头 1").click();
  const head=region.getByRole("slider",{name:"复刻播放头"});
  await head.focus(); await head.press("ArrowRight");
  await button(region,"在播放头添加切点").click();
  await button(page.getByRole("dialog",{name:"确认新增切点",exact:true}),"取消").click();
  await button(region,"重新检测").click();
  await button(page.getByRole("dialog",{name:"确认重新检测",exact:true}),"取消").click();
  await textbox.fill("手动编辑");
  await button(region,"与下一镜合并").click();
  const confirm=page.getByRole("dialog",{name:"确认合并镜头",exact:true});
  await confirm.getByRole("listitem").getByText(/镜头 01/).waitFor();
  await button(confirm,"取消").click(); assert.equal(await textbox.inputValue(),"手动编辑");
  await button(region,"与下一镜合并").click(); await button(confirm,"确认合并镜头").click();
  await button(region,"撤销上一步切点改动").click();
  await page.waitForFunction(()=>document.querySelector("#video-shot-1")?.value==="手动编辑");
  await button(region,"仅选待分析").click();
  await button(region,/分析选中镜头.*0\.054/).click();
  const q=page.getByRole("dialog",{name:"确认分析选中镜头",exact:true});
  await q.getByText(/提交 1 个镜头/).waitFor(); await button(q,"确认分析").click();
  await button(region,"停止后续镜头").click(); await region.getByText("已停止后续镜头").waitFor();
  await button(region,"重新分析本镜").click();
  const retry=page.getByRole("dialog",{name:"确认重新分析本镜",exact:true});
  await retry.getByText(/0\.054/).waitFor(); await button(retry,"取消").click();
  assert.equal(await textbox.inputValue(),"手动编辑");
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.command==="video_shots_start").map(c=>c.args.quote.shotIds)),[["1000-2000"]]);
  await button(region,"重新分析本镜").click();
  await button(retry,"确认重新分析").click();
  await page.waitForFunction(()=>document.querySelector("#video-shot-1")?.value==="重跑首帧");
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.command==="video_shots_start").map(c=>[c.args.quote.shotIds,c.args.quote.rerun])),[[["1000-2000"],false],[["0-1000"],true]]);
  const theme=await page.locator("html").getAttribute("data-theme");
  await page.evaluate(()=>document.documentElement.dataset.theme="light");
  await page.setViewportSize({width:820,height:760});
  const player=await workspace.getByRole("region",{name:"播放视频",exact:true}).boundingBox();
  const panel=await workspace.locator(".video-analysis-content").boundingBox(); assert.ok(panel.y>=player.y+player.height-1);
  await page.evaluate(t=>{if(t)document.documentElement.dataset.theme=t;else delete document.documentElement.dataset.theme;},theme);
  await page.setViewportSize({width:1400,height:900});
  await button(region,"返回分析").click();
}

export async function verifyShotBoardDelivery(page, url) {
  await page.goto(url);
  await page.locator('[data-canvas-node-id="video-plain"]').waitFor();
  await installShotMock(page);
  await page.evaluate(() => {
    const state=window.store.getState();
    window.store.setState({projects:[...state.projects,{...state.projects[0],id:"q",name:"其他项目"}]});
  });
  const workspace=page.getByRole("dialog",{name:"视频分析工作区",exact:true});
  const button=(parent,name)=>parent.getByRole("button",{name,exact:true});
  await page.locator('[data-canvas-node-id="video-plain"]').click();
  await button(page.getByRole("region",{name:"视频分析",exact:true}),"分析").click();
  await button(workspace,"复刻").click();
  const region=workspace.getByRole("region",{name:"复刻",exact:true});
  await region.getByText("还有 1 个选中镜头未分析，请先分析或取消勾选").waitFor();
  assert.equal(await button(region,"生成画板分镜卡").isEnabled(),false);
  await button(region,"仅选已分析的 1 个镜头").click();
  const deliveries=()=>page.evaluate(()=>window.calls.filter(c=>c.command==="video_shots_deliver").map(c=>c.args));
  async function send(kind,existing=false) {
    const title=kind==="note"?"生成画板分镜卡":"生成画板分镜工作流";
    await button(region,title).click();
    const setup=page.getByRole("dialog",{name:title,exact:true});
    const target=setup.getByRole("combobox",{name:"目标项目"});
    assert.equal(await target.inputValue(),"p");
    await target.selectOption("q"); await target.selectOption("p");
    await button(setup,"生成到画板").click();
    const result=page.getByRole("dialog",{name:existing?"已在项目画板中":"已发送到画板",exact:true});
    await result.waitFor();
    return result;
  }
  await button(await send("note"),"返回复刻").click();
  let [note]=await deliveries();
  assert.equal(note.focusId,"shot-note-"+note.deliveryKey);
  assert.deepEqual(note.shots.map(s=>[s.start,s.end]),[[0,1000]]);
  assert.equal(JSON.parse(note.frames[0].payloadJson).cells[0][0].image_refs[0].asset_id,"existing");
  assert.ok(JSON.parse(note.frames[0].payloadJson).cells[0][1].text.includes("运镜"));
  await button(await send("note",true),"返回复刻").click();
  const delivered=await send("workflow");
  const records=await deliveries(); assert.equal(records.length,2,"retry reuses the note receipt");
  const flow=records[1];
  const framePayload=JSON.parse(flow.frames[0].payloadJson);
  assert.equal(flow.frames[0].role,"reference");
  assert.equal(framePayload.schema_version,1);
  assert.equal(framePayload.snapshot.name,"镜头首帧");
  assert.equal(framePayload.snapshot.height,180);
  assert.deepEqual(flow.additions.map(n=>n.prompt),["首帧","运镜"]);
  assert.equal(flow.additions[0].inputs.image[0].assetNodeId,flow.frames[0].id);
  assert.equal(flow.additions[1].inputs.image[0].nodeId,flow.additions[0].id);
  assert.equal(flow.focusId,flow.additions[0].id);
  await button(delivered,"返回复刻").click();
  await button(await send("workflow",true),"前往画板查看").click();
  await workspace.waitFor({state:"hidden"});
  await page.waitForFunction(id=>window.consumedFocus===id,flow.focusId);
  await page.locator('[data-workflow-card="'+flow.focusId+'"].is-selected').waitFor();
  assert.equal((await deliveries()).length,2,"workflow retry doesn't append cards");
  // Native notes use the independently refreshed project graph.
  await page.evaluate(nodeId=>window.store.setState({creativeNavigation:{projectId:"p",threadId:null,nodeId,projectNode:true}}),note.focusId);
  await page.locator('[data-canvas-node-id="'+note.focusId+'"].is-selected').waitFor();
}
