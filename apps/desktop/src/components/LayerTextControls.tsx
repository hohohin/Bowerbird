import type { RefObject } from "react";
import type { LayerText } from "../lib/layerDocument";

export function LayerTextControls({ text, fonts, locked, inputRef, patch, restore }: {
  text: LayerText; fonts: string[]; locked: boolean; inputRef: RefObject<HTMLTextAreaElement>;
  patch: (patch: Partial<LayerText>) => void; restore: () => void;
}) {
  return <section className="layer-text-controls" aria-label="文字与字体编辑">
    <strong>文字与字体</strong>
    <label>文字内容<textarea ref={inputRef} aria-label="文字内容" rows={3} maxLength={5000} disabled={locked} value={text.content} onChange={event => patch({ content: event.target.value })} /></label>
    <label>字体<select aria-label="文字字体" disabled={locked} value={text.fontFamily} onChange={event => patch({ fontFamily: event.target.value })}>{[...new Set([text.fontFamily, ...fonts])].map(font => <option key={font} value={font}>{font}</option>)}</select></label>
    {!fonts.includes(text.fontFamily) && <p className="text-xs text-muted">本机缺少此字体，暂用系统字体显示；请选择已安装字体。</p>}
    <div className="layer-fields">{([
      { key: "fontSize", label: "字号", min: 1, max: 2000, step: 1 },
      { key: "lineHeight", label: "行距", min: .5, max: 5, step: .1 },
      { key: "letterSpacing", label: "字距", min: -50, max: 200, step: 1 },
    ] as const).map(({ key, label, min, max, step }) => <label key={key}>{label}<input aria-label={`文字${label}`} type="number" disabled={locked} min={min} max={max} step={step} value={text[key]} onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value) && value >= min && value <= max) patch({ [key]: value }); }} /></label>)}
      <label>颜色<input aria-label="文字颜色" type="color" disabled={locked} value={text.color} onChange={event => patch({ color: event.target.value })} /></label>
    </div>
    <label>对齐<select aria-label="文字对齐" disabled={locked} value={text.align} onChange={event => patch({ align: event.target.value as LayerText["align"] })}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
    <button className="app-button" aria-pressed={text.bold} disabled={locked} onClick={() => patch({ bold: !text.bold })}>加粗</button>
    <button className="app-button" title="显示原图片，保留当前文字内容与样式，可随时切回" disabled={locked} onClick={restore}>恢复原图片层</button>
    <p className="text-xs text-muted">原字体和特殊效果需手动调整。超出图层边界的文字会裁切。</p>
  </section>;
}
