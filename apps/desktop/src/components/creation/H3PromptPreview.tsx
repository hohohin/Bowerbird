import { useLayoutEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import type { H3CardPrompt } from "../../lib/canvasWorkflow";
import { CanvasTextarea } from "../CanvasTextarea";

const fieldNames = {
  integrated_multimodal_description: "画面与对白", overall_soundscape: "环境声场", non_diegetic_music: "配乐",
  subject_definitions: "主体定义", summary: "内容概要", retention_analysis: "参考素材保留方式", detailed_description: "详细描述",
};
const heading = new RegExp("^[ \\t]*(" + Object.keys(fieldNames).join("|") + ")[ \\t]*[:：][ \\t]*", "gim");
type Field = { label: string; key: string; start: number; end: number };

// Ranges point into the exact submitted text. Editing one field preserves the other fields and their separators.
function promptFields(text: string): Field[] {
  const headings = [...text.matchAll(heading)];
  const endBefore = (next?: number) => next === undefined ? text.length : next - (text[next - 2] === "\r" ? 2 : 1);
  const fields: Field[] = headings.map((match, i) => {
    const key = match[1].toLowerCase() as keyof typeof fieldNames;
    const start = match.index! + match[0].length;
    return { label: fieldNames[key], key, start, end: endBefore(headings[i + 1]?.index) };
  });
  const prefix = text.slice(0, headings[0]?.index ?? text.length).trimEnd();
  if (prefix || !fields.length) fields.unshift({ key: "", label: headings.length && /^How the reference pictures align/i.test(prefix) ? "帧对齐" : "提示词正文", start: 0, end: endBefore(headings[0]?.index) });
  return fields;
}

function firstDialogue(text: string): Field | undefined {
  const match = /<d>([ \t]*(?:\[[^\]\n]+\][ \t]*)?)([\s\S]*?)<\/d>/i.exec(text);
  if (!match) return;
  const start = match.index + 3 + match[1].length;
  return { key: "<d>", label: "对白快捷编辑", start, end: start + match[2].length };
}

export function H3PromptPreview({ draft, seconds, disabled, update, readText }: {
  draft: H3CardPrompt; seconds?: number; disabled: boolean; update: (changes: Partial<H3CardPrompt>) => void; readText: () => string;
}) {
  const [raw, setRaw] = useState(false);
  const peek = useRef<HTMLButtonElement>(null), editor = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);
  useLayoutEffect(() => {
    if (moveFocus.current) {
      (draft.expanded ? editor.current?.querySelector("textarea") : peek.current)?.focus({ preventScroll: true });
      moveFocus.current = false;
    }
  }, [draft.expanded]);
  const expand = (expanded: boolean) => { moveFocus.current = true; update({ expanded }); };
  const text = draft.edited ?? draft.result;
  const fields = promptFields(text);
  const dialogue = firstDialogue(text);
  const hasField = (key: string) => fields.some(f => f.key === key && !/^(?:n\/a)?$/i.test(text.slice(f.start, f.end).trim()));
  const facts = [seconds && `0.00s → ${seconds.toFixed(2)}s`, dialogue && `对白「${text.slice(dialogue.start, dialogue.end)}」`,
    hasField("overall_soundscape") && "含环境声场", hasField("non_diegetic_music") && "含配乐"].filter(Boolean);
  const edit = (edited: string) => update({ edited: edited === draft.result ? undefined : edited });
  if (!draft.expanded) return <button ref={peek} type="button" className="h3-prompt-peek" aria-expanded="false" disabled={disabled}
    aria-label="展开编辑优化后提示词" onClick={() => expand(true)}>
    {(draft.paused || !!facts.length) && <span className="h3-peek-facts">{draft.paused ? "已停用 · 运行时使用原文" : facts.join(" · ")}</span>}
    <span className="h3-peek-excerpt">{text || "优化稿为空"}</span><span className="h3-peek-cue"><Pencil size={11} />点击展开编辑</span>
  </button>;
  const rangeField = (field: Field, index: number) => {
    const range = (current: string) => index < 0 ? firstDialogue(current) : promptFields(current)[index];
    return <label key={index} className="h3-struct-field"><span>{field.label}<small>{field.key}</small></span>
      <CanvasTextarea aria-label={field.label} rows={index < 0 ? 1 : 2} disabled={disabled} value={text.slice(field.start, field.end)}
        readCurrentValue={() => { const current = readText(), f = range(current); return f ? current.slice(f.start, f.end) : ""; }}
        onValueChange={value => { const current = readText(), f = range(current); if (f) edit(current.slice(0, f.start) + value + current.slice(f.end)); }} />
    </label>;
  };
  return <div ref={editor} className="h3-prompt-editor">
    <div className="h3-editor-bar">
      {seconds !== undefined && <div role="group" aria-label="优化稿编辑视图">
        <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>结构化</button>
        <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>原文 (Raw)</button>
      </div>}
      {draft.edited !== undefined && <button type="button" disabled={disabled} onClick={() => update({ edited: undefined })}>还原</button>}
      <button type="button" disabled={disabled} aria-expanded="true" onClick={() => expand(false)}>收起</button>
    </div>
    {raw || seconds === undefined ? <CanvasTextarea className="h3-raw-field" aria-label="优化后提示词全文" rows={7} disabled={disabled}
      spellCheck={false} value={text} readCurrentValue={readText} onValueChange={edit} /> : <>
      {dialogue && rangeField(dialogue, -1)}
      {fields.map(rangeField)}
    </>}
  </div>;
}
