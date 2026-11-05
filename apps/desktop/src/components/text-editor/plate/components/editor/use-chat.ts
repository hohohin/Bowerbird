import { useEffect, useMemo } from 'react';
import { useChat as useBaseChat } from '@ai-sdk/react';
import { AIChatPlugin, applyTableCellSuggestion } from '@platejs/ai/react';
import { withAIBatch } from '@platejs/ai';
import { getCommentKey, getTransientCommentKey } from '@platejs/comment';
import { BlockSelectionPlugin } from '@platejs/selection/react';
import { KEYS, TextApi, type TElement } from 'platejs';
import { type ChatTransport, type UIMessageChunk } from 'ai';
import { useEditorRef, type PlateEditor } from 'platejs/react';
import { serializeMd } from '@platejs/markdown';
import { useTextEditorServices } from '../../../TextEditorServices';
import { textAgentSource } from '@/lib/textAgent';
import { parseMarkdown } from '@/lib/documentCodec';
import { discussionPlugin } from './plugins/discussion-kit';

export type ChatMessage = NonNullable<typeof AIChatPlugin.options.chat>['messages'][number];
type Generate = ReturnType<typeof useTextEditorServices>['generate'];
const textOf = (message: ChatMessage) => message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
function selectedContent(editor: PlateEditor, messages: ChatMessage[]) {
  const nodes = editor.getOption(AIChatPlugin, 'chatNodes');
  const selected = nodes.length ? nodes : editor.children;
  const current = () => selected.flatMap(node => {
    const entry = editor.api.node<TElement>({ at: [], match: candidate => candidate.id === node.id });
    return entry ? [entry[0]] : [];
  });
  const original = serializeMd(editor, { value: current() });
  const before = serializeMd(editor, { value: selected });
  const history = messages.slice(0, -1).filter(message => message.role !== 'system').map(message => ({ role: message.role as 'user' | 'assistant', text: textOf(message) }));
  return { before, source: textAgentSource(before, history), changed: () => serializeMd(editor, { value: current() }) !== original };
}
function prepareRequest(editor: PlateEditor, messages: ChatMessage[]) {
  const toolName = editor.getOption(AIChatPlugin, 'toolName') ?? 'generate';
  editor.setOption(AIChatPlugin, 'toolName', toolName);
  const cells = editor.getOption({ key: KEYS.table }, 'selectedCells') as TElement[] | null;
  const tableCells = toolName === 'edit' && cells && cells.length > 1 ? cells : null;
  const selection = editor.getOption(AIChatPlugin, 'chatSelection') ?? editor.selection;
  const bookmark = selection ? editor.api.rangeRef(selection) : null;
  const prompt = textOf(messages[messages.length - 1]) + (tableCells ? '\n请返回与所选单元格数量和顺序一致的 Markdown 表格，只返回修改后的表格内容。' : '');
  return { ...selectedContent(editor, messages), toolName, tableCells, bookmark, prompt };
}
type Request = ReturnType<typeof prepareRequest>;
function addComment(editor: PlateEditor, request: Request, response: string) {
  const at = request.bookmark?.current;
  if (!at) throw new Error('评论位置已改变，请重新选择文字。');
  const discussionId = crypto.randomUUID(), userId = editor.getOption(discussionPlugin, 'currentUserId');
  editor.setOption(discussionPlugin, 'pendingAgentDiscussionIds', [...editor.getOption(discussionPlugin, 'pendingAgentDiscussionIds'), discussionId]);
  editor.tf.setNodes({ [getCommentKey(discussionId)]: true, [getTransientCommentKey()]: true, [KEYS.comment]: true }, { at, match: TextApi.isText, split: true });
  editor.setOption(discussionPlugin, 'discussions', [...editor.getOption(discussionPlugin, 'discussions'), {
    id: discussionId, userId, createdAt: new Date(), isResolved: false, documentContent: request.before,
    comments: [{ id: crypto.randomUUID(), discussionId, userId, createdAt: new Date(), isEdited: false, contentRich: parseMarkdown(response) }],
  }]);
  editor.getApi(BlockSelectionPlugin).blockSelection.deselect();
}
function updateCells(editor: PlateEditor, cells: TElement[], response: string) {
  const table = parseMarkdown(response).find(node => node.type === KEYS.table);
  const updated = table?.children.flatMap(row => 'children' in row && Array.isArray(row.children) ? row.children : []) ?? [];
  if (updated.length !== cells.length) throw new Error('Agent 返回的表格与所选区域不匹配，未修改原表格。');
  withAIBatch(editor, () => updated.forEach((cell, index) => applyTableCellSuggestion(editor, { id: String(cells[index].id), content: serializeMd(editor, { value: (cell as TElement).children as typeof editor.children }) })));
}
function applyResponse(editor: PlateEditor, request: Request, response: string): boolean {
  if (request.changed()) {
    editor.setOption(AIChatPlugin, 'toolName', 'generate');
    editor.setOption(AIChatPlugin, 'mode', 'chat');
    return false;
  }
  if (request.toolName === 'comment') { addComment(editor, request, response); return true; }
  if (request.tableCells) { updateCells(editor, request.tableCells, response); return true; }
  return false;
}
function responseStream(editor: PlateEditor, generate: Generate, request: Request, signal?: AbortSignal) {
  return new ReadableStream<UIMessageChunk>({ async start(controller) {
    const id = crypto.randomUUID();
    try {
      const response = await generate(request.prompt, request.source, signal);
      if (signal?.aborted) { controller.close(); return; }
      const applied = applyResponse(editor, request, response);
      controller.enqueue({ type: 'start', messageId: id });
      if (!applied) {
        controller.enqueue({ type: 'text-start', id });
        controller.enqueue({ type: 'text-delta', id, delta: response });
        controller.enqueue({ type: 'text-end', id });
      }
      controller.enqueue({ type: 'finish' });
      controller.close();
    } catch (error) { controller.error(error); }
    finally { request.bookmark?.unref(); }
  } });
}
export function useChat() {
  const editor = useEditorRef();
  const { generate } = useTextEditorServices();
  const transport = useMemo<ChatTransport<ChatMessage>>(() => ({
    async reconnectToStream() { return null; },
    async sendMessages({ messages, abortSignal }) { return responseStream(editor, generate, prepareRequest(editor, messages), abortSignal); },
  }), [editor, generate]);
  const chat = useBaseChat<ChatMessage>({ transport });
  useEffect(() => { editor.setOption(AIChatPlugin, 'chat', chat); }, [editor, chat.status, chat.messages, chat.error]);
  useEffect(() => () => { void chat.stop(); }, []);
  return chat;
}
