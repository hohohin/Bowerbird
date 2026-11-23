// Adapted from @platejs/math 53.0.0 (MIT). See LICENSE.md in this directory tree.
import { KEYS, createRuleFactory, createSlatePlugin, matchDelimitedInline, type BlockFenceInputRuleMatch, type SlateEditor, type TRange } from 'platejs';

type InsertOptions = Parameters<SlateEditor['tf']['insertNodes']>[1];

export function insertEquation(editor: SlateEditor, options?: InsertOptions) {
  editor.tf.insertNodes({ children: [{ text: '' }], texExpression: '', type: editor.getType(KEYS.equation) }, options);
}

export function insertInlineEquation(editor: SlateEditor, texExpression?: string, options?: InsertOptions) {
  editor.tf.insertNodes({ children: [{ text: '' }], texExpression: texExpression ?? editor.api.string(editor.selection), type: editor.getType(KEYS.inlineEquation) }, options);
}

// The upstream schema entry also imports KaTeX and its CSS. Keep only the editing schema eager.
function createEquationPlugin(key: string, isInline: boolean) {
  return createSlatePlugin({
    key,
    node: { isElement: true, isInline, isVoid: true },
    parsers: { html: { deserializer: { toNodeProps: ({ element }) => ({ texExpression: element.getAttribute('data-slate-tex-expression') ?? '' }) } } },
  }).overrideEditor(({ editor, tf: { normalizeNode }, type }) => ({ transforms: { normalizeNode(entry) {
    const [node, path] = entry;
    if (node.type === type && typeof node.texExpression !== 'string') {
      const expression = node.texExpression;
      const texExpression = typeof expression === 'number' || typeof expression === 'boolean' ? String(expression) : '';
      editor.tf.setNodes({ texExpression }, { at: path });
      return;
    }
    normalizeNode(entry);
  } } }));
}

export const EquationSchema = createEquationPlugin(KEYS.equation, false);
export const InlineEquationSchema = createEquationPlugin(KEYS.inlineEquation, true);

const canInsertEquation = ({ editor }: { editor: SlateEditor }) => !editor.api.some({ match: {
  type: [editor.getType(KEYS.codeBlock), editor.getType(KEYS.equation), editor.getType(KEYS.inlineEquation)],
} });

export const BlockEquationRule = createRuleFactory<{}, {}, BlockFenceInputRuleMatch>({
  type: 'blockFence',
  fence: '$$',
  block: KEYS.p,
  on: 'break',
  enabled: canInsertEquation,
  priority: 100,
  apply: ({ editor }, match) => {
    editor.tf.removeNodes({ at: match.path });
    insertEquation(editor, { at: match.path, select: true });
    return true;
  },
});

export const InlineEquationRule = createRuleFactory<{}, {}, { deleteRange: TRange; texExpression: string }>({
  type: 'insertText',
  enabled: canInsertEquation,
  trigger: '$',
  resolve: context => {
    if (context.text !== '$' || context.options?.at) return;
    const match = matchDelimitedInline(context, {
      boundaryRe: /[\s([{'"`]/, followRe: /[\s)\]}:;,.!?'"`]/, open: '$', requireClosingDelimiter: false, trim: 'reject',
    });
    if (match) return { deleteRange: match.deleteRange, texExpression: match.content };
  },
  apply: ({ editor }, match) => {
    editor.tf.delete({ at: match.deleteRange });
    editor.tf.select(match.deleteRange.anchor);
    insertInlineEquation(editor, match.texExpression);
    return true;
  },
});
