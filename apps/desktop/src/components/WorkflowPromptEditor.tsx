import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Schema, type Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import { canvasInputValue, canvasWorkflowInputState } from "../lib/canvasSessionOutputs";
import { canvasAssetMediaPath } from "../lib/creativeCanvas";
import { workflowBindingKey, workflowImageContainer, workflowInputValues, workflowReferenceToken, type WorkflowNode, type WorkflowPromptReference } from "../lib/canvasWorkflow";
import type { Asset, CanvasNode } from "../lib/types";

const schema = new Schema({ nodes: {
  doc: { content: "paragraph+" }, paragraph: { content: "inline*", toDOM: () => ["p", 0], parseDOM: [{ tag: "p" }] },
  text: { group: "inline" },
  reference: { inline: true, group: "inline", atom: true, attrs: { id: {}, label: {}, thumb: { default: "" }, kind: {} },
    toDOM: node => ["span", { class: `workflow-prompt-reference is-${node.attrs.kind}`, "data-reference-id": node.attrs.id, contenteditable: "false", title: node.attrs.label },
      ...(node.attrs.thumb ? [["img", { src: node.attrs.thumb, alt: "" }]] : []), `@${node.attrs.label}`] },
} });
const serialize = (doc: PMNode) => doc.textBetween(0, doc.content.size, "\n", node => node.type.name === "reference" ? workflowReferenceToken(node.attrs.id) : "");
interface Candidate { reference: Omit<WorkflowPromptReference, "id">; preview: string; assetIds?: string[]; unavailable?: boolean }

export function WorkflowPromptEditor({ node, nodes, graphNodes, disabled, onChange }: {
  node: WorkflowNode; nodes: WorkflowNode[]; graphNodes: CanvasNode[]; disabled: boolean;
  onChange: (prompt: string, references: WorkflowPromptReference[]) => void;
}) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null);
  const [menu, setMenu] = useState<{ pos: number; left: number; top: number } | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const candidates = useMemo(() => (["text", "image"] as const).flatMap(type => (node.inputs[type] ?? []).flatMap((input, index): Candidate[] => {
    if (canvasWorkflowInputState(input, graphNodes, nodes) === "missing") return [{
      reference: { type, input, label: `${type === "text" ? "文本" : "图片来源"} ${index + 1}` },
      preview: "来源卡片或单元格已删除，请重新连接", unavailable: true,
    }];
    const source = nodes.find(node => node.id === input.nodeId);
    if (type === "image" && input.portId === "image" && source?.kind === "generation") {
      const count = source.outputs.image?.assetIds?.length ?? 0;
      return [{ reference: { type, input, label: `生成结果 ${index + 1}` }, assetIds: source.outputs.image?.assetIds, preview: count ? `本次 ${count} 张图片 · 重跑自动更新` : "本次生成图片 · 运行时等待上游" }];
    }
    try {
      const value = workflowInputValues(nodes, { ...node, inputs: { [type]: [input] } }, (id, cellId) => {
        const table = graphNodes.find(node => node.id === id && node.hiddenAt == null);
        return table ? canvasInputValue(table, cellId, graphNodes) : undefined;
      })[type][0];
      return type === "text" ? [{ reference: { type, input, label: `文本 ${index + 1}` }, preview: value.text || "（空文本）" }]
        : workflowImageContainer(input)
          ? [{ reference: { type, input, label: `图片来源 ${index + 1}` }, assetIds: value.assetIds, preview: `当前 ${value.assetIds?.length ?? 0} 张图片 · 随来源自动更新` }]
          : (value.assetIds ?? []).map((assetId, i) => ({ reference: { type, input, assetId, label: `图片 ${index + 1}.${i + 1}` }, preview: "" }));
    } catch {
      const pendingSource = type === "text" && (source || graphNodes.some(card => card.id === input.canvasNodeId && card.hiddenAt == null));
      return [{ reference: { type, input, label: `${type === "text" ? "文本" : "图片来源"} ${index + 1}` }, preview: "等待上游内容", unavailable: !(pendingSource || (type === "image" && workflowImageContainer(input))) }];
    }
  })), [node.inputs, nodes, graphNodes]);
  const referenceAssetId = (ref?: Omit<WorkflowPromptReference, "id">) => ref && workflowImageContainer(ref.input)
    ? candidates.find(candidate => candidate.reference.type === ref.type && workflowBindingKey(candidate.reference.input) === workflowBindingKey(ref.input))?.assetIds?.[0]
    : ref?.assetId;
  const assetKey = [...new Set([...candidates.flatMap(c => c.assetIds ?? (c.reference.assetId ? [c.reference.assetId] : [])), ...(node.promptReferences ?? []).map(referenceAssetId)].filter((id): id is string => !!id))].sort().join("|");
  useEffect(() => {
    let alive = true;
    void api.getAssetsByIds(assetKey ? assetKey.split("|") : []).then(assets => { if (alive) setAssets(assets); }).catch(() => {});
    return () => { alive = false; };
  }, [assetKey]);
  const imageSrc = (id?: string) => {
    const asset = assets.find(asset => asset.id === id);
    const path = asset && canvasAssetMediaPath({ storePath: asset.store_path ?? null, thumbPath: asset.thumb_path ?? null });
    return path ? path.startsWith("data:") ? path : convertFileSrc(path) : "";
  };
  function toDoc() {
    return schema.node("doc", null, node.prompt.split("\n").map(line => {
      const children: PMNode[] = []; let offset = 0;
      for (const match of line.matchAll(/@\[([^\]]+)\]/g)) {
        const reference = node.promptReferences?.find(ref => ref.id === match[1]);
        if (!reference) continue;
        if (match.index! > offset) children.push(schema.text(line.slice(offset, match.index)));
        children.push(schema.node("reference", { id: reference.id, label: reference.label, thumb: imageSrc(referenceAssetId(reference)), kind: reference.type }));
        offset = match.index! + match[0].length;
      }
      if (offset < line.length) children.push(schema.text(line.slice(offset)));
      return schema.node("paragraph", null, children);
    }));
  }
  const latest = useRef({ node, disabled, onChange }); latest.current = { node, disabled, onChange };
  useEffect(() => {
    const editor = new EditorView(host.current!, {
      state: EditorState.create({ schema, doc: toDoc(), plugins: [history(), keymap({ "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo }), keymap(baseKeymap)] }),
      attributes: { role: "textbox", "aria-label": node.kind === "planner" ? "工作流需求" : node.kind === "agent" ? "文本修改要求" : "卡片指令", "aria-multiline": "true", "data-placeholder": node.kind === "planner" ? "按 @ 引用输入，例如：保留 @原图 的版式，将产品替换为 @产品参考…" : node.kind === "agent" ? "按 @ 引入文本，再描述替换、改写或简写要求…" : "输入创作要求，按 @ 引入收到的图片或文字…" },
      editable: () => !latest.current.disabled,
      dispatchTransaction(tr) {
        editor.updateState(editor.state.apply(tr));
        const prompt = serialize(editor.state.doc);
        if (tr.docChanged) latest.current.onChange(prompt, latest.current.node.promptReferences ?? []);
        const { from, empty } = editor.state.selection;
        if (empty && from > 1 && editor.state.doc.textBetween(from - 1, from) === "@" && !editor.composing) {
          const rect = editor.coordsAtPos(from); setMenu({ pos: from - 1, left: rect.left, top: rect.bottom });
        } else setMenu(null);
      },
      handleKeyDown: (_, event) => { if (event.key === "Escape") { setMenu(null); return true; } return false; },
      handleDOMEvents: { blur: () => { setMenu(null); return false; } },
    });
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
  }, []);
  useEffect(() => {
    const editor = view.current; if (!editor) return;
    editor.setProps({ editable: () => !disabled });
    // External updates (reload/undo) replace the document; normal typing keeps its selection.
    if (serialize(editor.state.doc) !== node.prompt) editor.updateState(EditorState.create({ schema, doc: toDoc(), plugins: editor.state.plugins }));
  }, [node.prompt, disabled]);
  useEffect(() => {
    const editor = view.current; if (!editor) return;
    const tr = editor.state.tr;
    editor.state.doc.descendants((item, pos) => {
      if (item.type.name !== "reference") return;
      const reference = node.promptReferences?.find(ref => ref.id === item.attrs.id);
      const thumb = imageSrc(referenceAssetId(reference));
      if (thumb !== item.attrs.thumb) tr.setNodeMarkup(pos, undefined, { ...item.attrs, thumb });
    });
    if (tr.docChanged) editor.updateState(editor.state.apply(tr.setMeta("addToHistory", false)));
  }, [assets, candidates, node.promptReferences]);
  function insert(candidate: Candidate) {
    const editor = view.current; if (!editor || !menu || candidate.unavailable) return;
    const reference = { ...candidate.reference, id: crypto.randomUUID() };
    const tr = editor.state.tr.replaceWith(menu.pos, menu.pos + 1, schema.node("reference", { id: reference.id, label: reference.label, thumb: imageSrc(referenceAssetId(reference)), kind: reference.type }));
    const state = editor.state.apply(tr); editor.updateState(state);
    onChange(serialize(state.doc), [...(node.promptReferences ?? []), reference]);
    setMenu(null); editor.focus();
  }
  return <><div ref={host} className="workflow-prompt-editor" onPointerDown={event => event.stopPropagation()} />
    {menu && !disabled && createPortal(<div className="workflow-reference-menu" role="listbox" aria-label="收到的内容" style={{ left: Math.max(8, Math.min(menu.left, window.innerWidth - 300)), top: Math.min(menu.top + 6, window.innerHeight - 280) }} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }}>
      <strong>收到的内容</strong>{!candidates.length && <p>连接图片或文本输入后，可在这里引用</p>}
      {candidates.map((candidate, index) => <button key={index} role="option" aria-selected={false} disabled={candidate.unavailable} onMouseDown={event => event.preventDefault()} onClick={() => insert(candidate)}>
        {candidate.reference.type === "image" && imageSrc(referenceAssetId(candidate.reference)) && <img src={imageSrc(referenceAssetId(candidate.reference))} alt="" />}
        <span><b>{candidate.reference.label}</b><small>{candidate.preview || assets.find(asset => asset.id === candidate.reference.assetId)?.name}</small></span>
      </button>)}
    </div>, window.document.body)}</>;
}
