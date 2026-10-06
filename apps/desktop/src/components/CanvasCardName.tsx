import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { canvasCardNameError } from "../lib/canvasCardNames";

export function CanvasCardName({ id, name, names, activeIds, style, disabled, onSave }: {
  id: string; name: string; names: Record<string, string>; activeIds: Set<string>; style?: CSSProperties;
  disabled?: boolean; onSave: (name: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(name);
  const [saveError, setSaveError] = useState("");
  const saving = useRef(false);
  const messageId = useId();
  useEffect(() => { setDraft(name); setSaveError(""); }, [name]);
  const error = canvasCardNameError(id, draft, names, activeIds) || saveError;
  async function commit() {
    if (error || draft.trim() === name || saving.current) return;
    saving.current = true;
    try { await onSave(draft.trim()); }
    catch (error) { setSaveError(String(error instanceof Error ? error.message : error)); }
    finally { saving.current = false; }
  }
  return <div className={`canvas-card-name ${error ? "is-invalid" : ""}`} data-card-name={id} style={style}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
    <input aria-label="卡片名称" title={name} value={draft} maxLength={80} disabled={disabled}
      aria-invalid={!!error} aria-describedby={error ? messageId : undefined}
      style={{ width: `${Math.max(8, [...draft].reduce((width, char) => width + (char.charCodeAt(0) > 255 ? 2 : 1), 2))}ch` }}
      onChange={event => { setDraft(event.target.value); setSaveError(""); }} onBlur={() => void commit()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === "Escape") { event.preventDefault(); setDraft(name); setSaveError(""); }
      }} />
    {error && <span id={messageId} role="alert">{error}</span>}
  </div>;
}
