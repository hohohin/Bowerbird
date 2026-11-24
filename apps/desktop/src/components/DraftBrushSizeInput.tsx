import { useEffect, useRef, useState } from "react";
import { DRAFT_BRUSH_MIN_SIZE, DRAFT_BRUSH_MAX_SIZE, DRAFT_BRUSH_SIZE_STEP, normalizeDraftBrushSize } from "../lib/draftBrushSize";

/** Keep editable text intact while valid diameters immediately update the brush preview. */
export function DraftBrushSizeInput({ value, onChange, disabled, "aria-label": label }: {
  value: number; onChange: (value: number) => void; disabled?: boolean; "aria-label": string;
}) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(String(value)); }, [value]);
  function commit(text = draft) {
    const parsed = text.trim() ? Number(text) : NaN;
    const next = normalizeDraftBrushSize(parsed, value);
    setDraft(String(next));
    if (next !== value) onChange(next);
  }
  return <input className="draft-brush-size-input" type="text" inputMode="decimal" role="spinbutton" aria-label={label}
    aria-valuemin={DRAFT_BRUSH_MIN_SIZE} aria-valuemax={DRAFT_BRUSH_MAX_SIZE} aria-valuenow={value}
    value={draft} disabled={disabled} onFocus={() => { editing.current = true; }}
    onChange={event => {
      const text = event.currentTarget.value;
      setDraft(text);
      const parsed = text.trim() ? Number(text) : NaN;
      if (Number.isFinite(parsed)) {
        const next = normalizeDraftBrushSize(parsed, value);
        if (next !== value) onChange(next);
      }
    }} onBlur={() => { editing.current = false; commit(); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commit(); }
      else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); event.stopPropagation();
        const parsed = draft.trim() ? Number(draft) : NaN;
        const current = normalizeDraftBrushSize(parsed, value);
        commit(String(current + (event.key === "ArrowUp" ? 1 : -1) * DRAFT_BRUSH_SIZE_STEP));
      }
    }} />;
}
