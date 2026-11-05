import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useEditorRef, useEditorSelector, type PlateEditor } from "platejs/react";
import { toggleList } from "@platejs/list";
import { Bold, Code, Italic, List, ListOrdered, Quote } from "lucide-react";
import { usePortalTarget } from "../lib/portalTarget";
import { TextBlockType } from "./TextBlockType";

const formats = [
  { key: "bold", label: "加粗", icon: <Bold size={14}/>, kind: "mark" },
  { key: "italic", label: "斜体", icon: <Italic size={14}/>, kind: "mark" },
  { key: "code", label: "行内代码", icon: <Code size={14}/>, kind: "mark" },
  { key: "disc", label: "列表", icon: <List size={14}/>, kind: "list" },
  { key: "decimal", label: "有序列表", icon: <ListOrdered size={14}/>, kind: "list" },
  { key: "blockquote", label: "引用", icon: <Quote size={14}/>, kind: "block" },
] as const;

export function TextFormatButtons() {
  const editor = useEditorRef();
  const active = useEditorSelector(editor => {
    const block = editor.api.block()?.[0], marks = editor.api.marks();
    return formats.map(format => format.kind === "mark" ? !!marks?.[format.key] : format.kind === "list" ? block?.listStyleType === format.key : editor.api.some({ match: { type: format.key } }));
  }, [], { equalityFn: (a, b) => a.every((item, index) => item === b[index]) });
  return <><TextBlockType/>{formats.map((format, index) => <button key={format.key} type="button" aria-label={format.label} title={format.label} aria-pressed={active[index]} onClick={() => {
    if (format.kind === "mark") editor.tf.toggleMark(format.key);
    else if (format.kind === "list") toggleList(editor, { listStyleType: format.key });
    else editor.tf.toggleBlock(format.key, { wrap: format.key === "blockquote" });
    editor.tf.focus();
  }}>{format.icon}</button>)}</>;
}

function selectionBounds(body: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !selection.toString().trim()) return null;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
  const rect = range.getBoundingClientRect(), bounds = body.getBoundingClientRect();
  if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) return null;
  return { rect, bounds };
}

function toolbarPosition(editor: PlateEditor, body: HTMLElement, bar: HTMLElement) {
  const focused = document.activeElement === body || bar.contains(document.activeElement);
  const selection = selectionBounds(body);
  if (!focused || !editor.api.isExpanded() || !selection) return null;
  const { rect, bounds } = selection, width = bar.offsetWidth, height = bar.offsetHeight;
  const left = Math.max(bounds.left + 4, Math.min(rect.left + rect.width / 2 - width / 2, bounds.right - width - 4));
  const above = rect.top - height - 8;
  const top = Math.max(bounds.top + 4, Math.min(above >= bounds.top ? above : rect.bottom + 8, bounds.bottom - height - 4));
  return { left, top };
}

function toolbarKeyDown(event: KeyboardEvent, bar: HTMLElement, dismiss: () => void) {
  if (event.isComposing) return;
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
  else if (event.altKey && event.key === "F10") { event.preventDefault(); bar.querySelector("button")?.focus(); }
}

export function TextSelectionToolbar({ bodyRef }: { bodyRef: RefObject<HTMLDivElement | null> }) {
  const editor = useEditorRef(), target = usePortalTarget();
  const toolbar = useRef<HTMLDivElement>(null);
  const refresh = useRef(() => {});
  const selectionKey = useEditorSelector(editor => JSON.stringify(editor.selection), []);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => refresh.current(), [selectionKey]);
  useEffect(() => {
    const body = bodyRef.current, bar = toolbar.current;
    if (!body || !bar) return;
    let composing = false, dismissed = "", frame = 0, visible = false;
    const hide = () => { visible = false; setPosition(null); };
    const update = () => {
      if (composing || dismissed === JSON.stringify(editor.selection)) { hide(); return; }
      const next = toolbarPosition(editor, body, bar);
      visible = !!next; setPosition(next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    refresh.current = schedule;
    const start = () => { composing = true; hide(); };
    const end = () => { composing = false; schedule(); };
    const keyDown = (event: KeyboardEvent) => {
      if (visible) toolbarKeyDown(event, bar, () => { dismissed = JSON.stringify(editor.selection); hide(); editor.tf.focus(); });
    };
    const events = ["selectionchange", "focusin", "focusout", "pointerup", "scroll"] as const;
    events.forEach(name => document.addEventListener(name, schedule, true));
    document.addEventListener("keydown", keyDown, true);
    body.addEventListener("compositionstart", start); body.addEventListener("compositionend", end);
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule); observer.observe(body); observer.observe(bar);
    schedule();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      refresh.current = () => {};
      events.forEach(name => document.removeEventListener(name, schedule, true));
      document.removeEventListener("keydown", keyDown, true);
      body.removeEventListener("compositionstart", start); body.removeEventListener("compositionend", end);
      window.removeEventListener("resize", schedule);
    };
  }, [bodyRef, editor, target]);
  return createPortal(<div ref={toolbar} className="text-selection-toolbar" role="toolbar" aria-label="选中文字格式"
    style={{ ...position, visibility: position ? "visible" : "hidden" }} onMouseDown={event => event.preventDefault()}>
    <TextFormatButtons/>
  </div>, target);
}
