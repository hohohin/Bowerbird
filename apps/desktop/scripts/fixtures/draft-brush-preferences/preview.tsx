import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useDraftBrushPreferences, type DraftBrushTool } from "../../../src/components/useDraftBrushPreferences";
import { DraftBrushSizeInput } from "../../../src/components/DraftBrushSizeInput";

function Editor() {
  const [tool, setTool] = useState<DraftBrushTool>("brush");
  const { size, hardness, opacity, smoothing, pressure, inertia, setSize, setHardness, setOpacity, setSmoothing, setPressure, setInertia } = useDraftBrushPreferences(tool);
  (window as any).setPreference = (key: string, value: number) => ({ size: setSize, hardness: setHardness, opacity: setOpacity, smoothing: setSmoothing, inertia: setInertia })[key as "size"](value);
  return <section>
    <button onClick={() => setTool("brush")}>画笔</button><button onClick={() => setTool("eraser")}>橡皮</button>
    <output data-preferences>{JSON.stringify({ tool, size, hardness, opacity, smoothing, pressure, inertia })}</output>
    <label>大小<DraftBrushSizeInput key={tool} aria-label="大小" value={size} onChange={setSize} /></label>
    <label>硬度<input aria-label="硬度" type="number" value={hardness} onChange={e => setHardness(e.target.valueAsNumber)} /></label>
    <label>不透明度<input aria-label="不透明度" type="number" value={opacity} onChange={e => setOpacity(e.target.valueAsNumber)} /></label>
    <label>平滑<input aria-label="平滑" type="number" value={smoothing} onChange={e => setSmoothing(e.target.valueAsNumber)} /></label>
    <label>压感<input aria-label="压感" type="checkbox" checked={pressure} onChange={e => setPressure(e.target.checked)} /></label>
    <label>惯性<input aria-label="惯性" type="number" value={inertia} onChange={e => setInertia(e.target.valueAsNumber)} /></label>
    <button onClick={() => { setSize(value => value + 1); setSize(value => value + 1); }}>连续增大两次</button>
  </section>;
}
function Fixture() {
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(value => !value)}>{open ? "关闭编辑器" : "重开编辑器"}</button>{open && <Editor />}</>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
