import React from "react";
import { createRoot } from "react-dom/client";
import { LocalChatPanel } from "../../../src/components/LocalChatPanel";
import { useStore } from "../../../src/store";
import { useLocalChatStore } from "../../../src/lib/localChatStore";
import { install, assets, inspect, finish } from "../local-chat/mock";
import "../../../src/styles.css";

install(window);
assets.push({ ...assets[0], id: "video-output", name: "合成视频", store_path: "/.tmp/chat-video-ui/result.mp4" });
useStore.setState({cloudAuth:{logged_in:true,cloud_available:true} as any,cloudEntitlement:{plan:"pro",policy:{can_use_byo:true},balances:{daily:0,sub:0,topup:0}} as any,codexHealth:{ok:true,reason:""}});
async function start() {
  if (!Object.keys(inspect().conversations).length) {
    await useLocalChatStore.getState().send({projectId:"p",provider:"codex-local",text:"制作一个视频",referenceAssetIds:[]});
    finish();
  }
  const id = Object.keys(inspect().conversations)[0];
  createRoot(document.getElementById("root")!).render(<div style={{width:620,height:850}}><LocalChatPanel conversationId={id} projectId="p" onClose={()=>{}} /></div>);
}
void start();
