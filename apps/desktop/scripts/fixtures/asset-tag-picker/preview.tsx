import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AssetTagPicker } from "../../../src/components/AssetTagPicker";
import type { AssetTag } from "../../../src/lib/types";
import "../../../src/styles.css";
import "../../../src/components/TacticalProjection.css";
import "../../../src/components/TacticalMenus.css";
import "../../../src/components/IndustrialTheme.css";
import "../../../src/components/IndustrialMenus.css";

(window as any).__TAURI_INTERNALS__ = { invoke: async () => [] };
function Preview() {
  const [open, setOpen] = useState(true), [version, setVersion] = useState(0);
  const [tags, setTags] = useState<AssetTag[]>([{ name: "时装", source: "manual", origin: "manual" }]);
  return <main style={{ padding: 24 }}>
    <button title="重播展开动效" onClick={() => { setOpen(true); setVersion(v => v + 1); }}>重开详情</button>
    {open && <div role="dialog" aria-label="图片与会话预览" onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
      <section role="region" aria-label="图片详情" style={{ width: 300, maxWidth: "100%", marginTop: 40, padding: 20, background: "var(--bb-surface)" }}>
        <button aria-label="关闭预览" onClick={() => setOpen(false)}>关闭</button>
        <AssetTagPicker key={version} assetId="review-two" tags={tags} onChange={setTags}/>
      </section>
    </div>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
