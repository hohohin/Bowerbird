import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from "react";
import { Plate, PlateContainer, PlateContent, PlateElement, createPlatePlugin, usePlateEditor, useEditorRef, usePluginOption, type PlateElementProps } from "platejs/react";
import type { Value } from "platejs";
import { BlockSelectionPlugin } from '@platejs/selection/react';
import type { DocumentMedia, DocumentValue } from "../lib/documentTypes";
import { normalizeDocument, parseMarkdown } from "../lib/documentCodec";
import { getDragAssets } from "../lib/dragPayload";
import { TextAgentScope } from "./TextAgent";
import { focusTextTail, readTextSelection } from "./textBlockTransforms";
import { EditorKit } from './text-editor/plate/components/editor/editor-kit';
import { FixedToolbar } from './text-editor/plate/ui/fixed-toolbar';
import { FixedToolbarButtons } from './text-editor/plate/ui/fixed-toolbar-buttons';
import { TooltipProvider } from './text-editor/plate/primitives/tooltip';
import { TextEditorServices } from './text-editor/TextEditorServices';
import { TextMediaContext, TextMediaElement } from './text-editor/TextMediaElements';
import { discussionPlugin } from './text-editor/plate/components/editor/plugins/discussion-kit';
import './text-editor/plate/utilities.css';
import './text-editor/TextEditor.css';

export interface TextPlateInsertion { insert(media: DocumentMedia[]): void; cancel(): void }
export interface TextPlateHandle { insertMedia(media: DocumentMedia[]): void; insertMarkdown(text: string): void; reserveInsertion(): TextPlateInsertion }
interface Props {
  agent?: { projectId?: string };
  toolbarStart?: ReactNode;
  toolbarEnd?: ReactNode;
  value: DocumentValue;
  media: DocumentMedia[];
  onChange(value: DocumentValue): void;
  onDropAssets(ids: string[]): Promise<DocumentMedia[]>;
}
function plateValue(value: DocumentValue): Value {
  const next = structuredClone(value);
  const visit = (nodes: Value) => nodes.forEach(node => {
    if (typeof node.caption === 'string' && ['img', 'audio', 'video'].includes(node.type)) node.caption = [{ text: node.caption }];
    visit(node.children.filter((child): child is Value[number] => typeof child.type === 'string' && Array.isArray(child.children)));
  });
  visit(next);
  return next;
}

function RawElement(props: PlateElementProps) { return <PlateElement {...props} as="pre" className="text-document-raw">{props.children}</PlateElement>; }
function DiscussionChanges({ onChange }: { onChange(value: Value): void }) {
  const editor = useEditorRef();
  const discussions = usePluginOption(discussionPlugin, 'discussions');
  const previous = useRef(discussions);
  useEffect(() => {
    if (discussions !== previous.current) { previous.current = discussions; onChange(editor.children); }
  }, [discussions, editor, onChange]);
  return null;
}

export const TextPlateEditor = forwardRef<TextPlateHandle, Props>(function TextPlateEditor({ value, media, onChange, onDropAssets, toolbarStart, toolbarEnd, agent }, ref) {
  const editor = usePlateEditor({
    plugins: [...EditorKit.filter(plugin => plugin.key !== 'fixed-toolbar').map(plugin => plugin.key === 'discussion' ? discussionPlugin.extend({ options: { discussions: value.discussions ?? [] } }) : plugin), createPlatePlugin({ key: "raw", node: { isElement: true, component: RawElement } })],
    value: plateValue(value),
    override: { components: { img: TextMediaElement, audio: TextMediaElement, video: TextMediaElement } },
  });
  const bodyRef = useRef<HTMLDivElement>(null);
  const emitted = useRef(value), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (value !== emitted.current) {
    emitted.current = value;
    editor.setOption(discussionPlugin, 'discussions', value.discussions ?? []);
    editor.tf.setValue(plateValue(value));
  } }, [editor, value]);
  useEffect(() => {
    editor.tf.withoutSaving(() => editor.tf.withoutNormalizing(() => {
      for (const [node, at] of editor.api.nodes({ at: [], match: node => !!node.assetId })) {
        const source = media.find(item => item.asset.id === node.assetId);
        if (source && node.url !== source.url) editor.tf.setNodes({ url: source.url }, { at });
      }
    }));
  }, [editor, media]);
  function insertMedia(items: DocumentMedia[]) {
    if (!items.length) return;
    editor.tf.insertNodes([...items.map(item => ({ id: crypto.randomUUID(), type: item.kind === "image" ? "img" : item.kind,
      assetId: item.asset.id, sourcePath: item.path, url: item.url, caption: [{ text: '' }], children: [{ text: "" }] })), { id: crypto.randomUUID(), type: "p", children: [{ text: "" }] }], { select: true });
    editor.tf.focus();
  }
  function reserveInsertion(): TextPlateInsertion {
    const end = editor.api.end([]);
    const selection = editor.selection ?? (end ? { anchor: end, focus: end } : null);
    if (!selection) return { insert() {}, cancel() {} };
    const bookmark = editor.api.rangeRef(selection, { affinity: "forward" });
    let used = false;
    const cancel = () => { if (!used) { used = true; bookmark.unref(); } };
    return { cancel, insert(items) {
      if (used) return;
      const range = bookmark.current;
      cancel();
      if (!mounted.current || !range) return;
      editor.tf.select(range); insertMedia(items);
    } };
  }
  function insertMarkdown(text: string) { editor.tf.insertNodes(parseMarkdown(text), { select: true }); editor.tf.focus(); }
  function emitChange(changed: Value) {
    const next = normalizeDocument(changed);
    const discussions = editor.getOption(discussionPlugin, 'discussions');
    if (discussions.length) next.discussions = discussions;
    emitted.current = next; onChange(next);
  }
  useImperativeHandle(ref, () => ({ insertMedia, insertMarkdown, reserveInsertion }));
  const content = <div className="text-plate-ui text-plate-shell">
    <div className="text-plate-toolbar">
      {(toolbarStart || toolbarEnd) && <div className="text-document-format text-plate-document-actions">{toolbarStart}<span className="text-plate-toolbar-spacer"/>{toolbarEnd}</div>}
      <FixedToolbar aria-label="文字格式"><FixedToolbarButtons/></FixedToolbar>
    </div>
    <PlateContainer className="text-plate-container">
    <PlateContent ref={bodyRef} className="text-document-body" aria-label="文档正文" spellCheck={false} placeholder="开始写作…"
      onClickCapture={event => {
        if (editor.dom.readOnly) return;
        if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.target !== event.currentTarget) return;
        if (window.getSelection()?.isCollapsed === false) return;
        const node = editor.children[editor.children.length - 1];
        const last = node ? editor.api.toDOMNode(node) : undefined;
        if (last && event.clientY <= last.getBoundingClientRect().bottom) return;
        event.preventDefault();
        event.stopPropagation();
        editor.getApi(BlockSelectionPlugin).blockSelection.deselect();
        focusTextTail(editor);
      }}
      onKeyDown={event => {
        if (event.key === "Tab" && !event.nativeEvent.isComposing) {
          const range = readTextSelection(editor);
          if (range) editor.tf.select(range);
        }
        if (event.altKey && event.key === "Enter" && !event.nativeEvent.isComposing) {
          const anchor = window.getSelection()?.anchorNode;
          const block = anchor?.parentElement?.closest('.text-document-block');
          const handle = block?.querySelector<HTMLButtonElement>('button[aria-label="段落操作"]');
          if (handle) { event.preventDefault(); handle.click(); }
        }
      }}
      onDragOver={event => { if (getDragAssets()?.length) event.preventDefault(); }}
      onDrop={event => {
        const ids = getDragAssets();
        if (!ids?.length) return;
        event.preventDefault(); event.stopPropagation();
        const range = editor.api.findEventRange(event);
        if (range) editor.tf.select(range);
        const insertion = reserveInsertion();
        void onDropAssets(ids).then(insertion.insert, insertion.cancel);
      }} />
    </PlateContainer>
  </div>;
  return <TextEditorServices projectId={agent?.projectId}><TooltipProvider><TextMediaContext.Provider value={media}><Plate editor={editor} onValueChange={({ value: changed }) => emitChange(changed)}>
    <DiscussionChanges onChange={emitChange}/>
    {agent ? <TextAgentScope editor={editor} projectId={agent.projectId}>{content}</TextAgentScope> : content}
  </Plate></TextMediaContext.Provider></TooltipProvider></TextEditorServices>;
});
