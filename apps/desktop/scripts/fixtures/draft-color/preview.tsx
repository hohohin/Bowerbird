import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { DraftColorPanel } from "../../../src/components/DraftColorPanel";
import "../../../src/styles.css";
import "../../../src/components/DraftEditor.css";

const w = window as any;
w.changes = [];
function Fixture() {
  const [color, setColor] = useState("#ff0000"), [disabled, setDisabled] = useState(false);
  w.setExternalColor = setColor; w.setDisabled = setDisabled;
  return <main className="draft-editor" style={{ display: "flex", gap: 32, alignItems: "flex-start", padding: 40 }}>
    <aside style={{ width: 252, background: "var(--bb-surface)", border: "1px solid var(--bb-line)" }}>
      <DraftColorPanel color={color} disabled={disabled} onChange={value => { w.changes.push(value); setColor(value); }}/>
    </aside>
    <div style={{ display: "grid", gap: 20 }}><output aria-label="当前前景色">{color}</output>
      <label>顶部颜色 <input type="color" aria-label="模拟顶部颜色" value={color} onChange={event => setColor(event.target.value)}/></label>
      <button onClick={() => setDisabled(value => !value)}>切换禁用</button>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture/></React.StrictMode>);
