import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the production schema, keymaps and serializer with genuine PM transactions.
// No browser, Tauri runtime, user library or provider is involved.
const require = createRequire(import.meta.url);
const { EditorState, TextSelection } = require('prosemirror-state');
const modules = new Map();
function load(path) {
  if (modules.has(path)) return modules.get(path).exports;
  const module = { exports: {} }; modules.set(path, module);
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const localRequire = specifier => {
    if (specifier === '@tauri-apps/api/core') return { convertFileSrc: value => value };
    if (specifier.startsWith('.')) return load(resolve(dirname(path), `${specifier}.ts`));
    return require(specifier);
  };
  vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: path })(localRequire, module, module.exports);
  return module.exports;
}
const source = fileURLToPath(new URL('../src/components/creation/', import.meta.url));
const { creationSchema: schema } = load(resolve(source, 'schema.ts'));
const { buildPlugins } = load(resolve(source, 'plugins.ts'));
const { serializeDoc } = load(resolve(source, 'serialize.ts'));
const { parseCreativeComposerState, serializeCreativeComposerState } = load(fileURLToPath(new URL('../src/lib/creativeDraft.ts', import.meta.url)));
const reference = { id: 'synthetic-image', name: '合成花影', ext: 'png', sections: [{ id: 'color', title: '配色', body: '粉灰色' }] };

function editor(text, chat = true) {
  const assets = new Map([[reference.id, reference]]);
  const viewRef = { current: null };
  const plugins = buildPlugins({ viewRef, assetByIdRef: { current: assets }, chipSectionsRef: { current: reference.sections }, chipAssetIdRef: { current: reference.id }, enterInsertsParagraph: chat });
  const doc = schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, text ? schema.text(text) : null)]);
  const view = { composing: false, state: EditorState.create({ doc, selection: TextSelection.atEnd(doc), plugins }), dispatch: transaction => { view.state = view.state.apply(transaction); } };
  viewRef.current = view;
  return { view, assets,
    key: (key, shiftKey = false) => plugins.some(plugin => plugin.props.handleKeyDown?.(view, { key, keyCode: key === 'Enter' ? 13 : 32, shiftKey, ctrlKey: false, metaKey: false, altKey: false })),
    type: text => view.dispatch(view.state.tr.insertText(text)),
    prompt: () => serializeDoc(view.state.doc, assets).finalPrompt,
  };
}

test('chat Enter and Shift+Enter create real paragraphs that serialize and restore as newlines', () => {
  const f = editor('第一行');
  assert.equal(f.key('Enter'), true); f.type('第二行');
  assert.equal(f.key('Enter', true), true); f.type('第三行');
  assert.equal(f.view.state.doc.childCount, 3);
  assert.equal(f.prompt(), '第一行\n第二行\n第三行');
  const saved = serializeCreativeComposerState({ mode: 'chat', drafts: { chat: { doc: f.view.state.doc.toJSON(), refs: [] } } });
  const restored = schema.nodeFromJSON(parseCreativeComposerState(saved).drafts.chat.doc);
  assert.equal(restored.childCount, 3);
  assert.equal(serializeDoc(restored, f.assets).finalPrompt, '第一行\n第二行\n第三行');
});

test('chat Enter after a matching image name inserts a paragraph without consuming the text as a chip', () => {
  const f = editor('@合成花影');
  assert.equal(f.key('Enter'), true); f.type('继续描述');
  assert.equal(f.view.state.doc.childCount, 2);
  assert.equal(f.view.state.doc.firstChild.firstChild.type.name, 'text');
  assert.equal(f.prompt(), '@合成花影\n继续描述');
  assert.equal(serializeDoc(f.view.state.doc, f.assets).references.length, 0);
});

test('chat Enter after a matching dimension title keeps the requested text and newline', () => {
  const f = editor('讨论配色');
  assert.equal(f.key('Enter'), true); f.type('下一段');
  assert.equal(f.view.state.doc.childCount, 2);
  assert.equal(f.prompt(), '讨论配色\n下一段');
  assert.equal(f.view.state.doc.firstChild.childCount, 1);
  assert.equal(f.view.state.doc.firstChild.firstChild.type.name, 'text');
});

test('image/video editors retain Enter smart matching for assets and dimensions', () => {
  for (const [text, expectedNode] of [['@合成花影', 'image'], ['配色', 'keyword']]) {
    const f = editor(text, false);
    assert.equal(f.key('Enter'), true);
    assert.equal(f.view.state.doc.childCount, 1);
    assert.equal(f.view.state.doc.firstChild.firstChild.type.name, expectedNode);
  }
});

test('Shift+Enter inserts a paragraph in both chat and media editors even after a matching token', () => {
  for (const chat of [true, false]) {
    const f = editor('@合成花影', chat);
    assert.equal(f.key('Enter', true), true); f.type('继续描述');
    assert.equal(f.view.state.doc.childCount, 2);
    assert.equal(f.view.state.doc.firstChild.firstChild.type.name, 'text');
    assert.equal(f.prompt(), '@合成花影\n继续描述');
  }
});
