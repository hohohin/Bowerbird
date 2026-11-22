import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createLocalFileMode, libraryShortcutSource } from '../src/lib/localFileMode.ts';

let saved;
beforeEach(() => {
  saved = new Map();
  globalThis.localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  };
});

function navigation(mode) {
  const { source, lens, media } = mode.getState();
  return { source, lens, media };
}

test('old storage restores each view, its media and the tag scope', () => {
  for (const [view, tagSource, source, lens] of [
    ['global', 'project', 'global', 'flow'],
    ['project', 'global', 'project', 'flow'],
    ['tags', 'global', 'global', 'tags'],
    ['tags', 'project', 'project', 'tags'],
    ['collections', 'project', 'folders', 'flow'],
  ]) {
    saved.set('bowerbird.libraryView.main.home', JSON.stringify({ view, tagSource, media: 'videos' }));
    const mode = createLocalFileMode();
    assert.deepEqual(navigation(mode), { source, lens, media: 'videos' });
    mode.getState().setMedia('all');
    assert.deepEqual(JSON.parse(saved.get('bowerbird.libraryView.main.home')), { source, lens, media: 'all' });
    assert.deepEqual(navigation(createLocalFileMode()), { source, lens, media: 'all' });
  }
});

test('home and each project restore independent source, lens, project and media', () => {
  const mode = createLocalFileMode();
  mode.getState().setLens('tags');
  mode.getState().openSource('folders');
  mode.getState().setProjectContext('a');
  assert.deepEqual(navigation(mode), { source: 'project', lens: 'flow', media: 'images' });
  mode.getState().selectProject('b');
  mode.getState().openSource('global');
  mode.getState().setMedia('texts');
  mode.getState().setProjectContext('b');
  assert.equal(mode.getState().browseProjectId, 'b');
  mode.getState().setProjectContext(null);
  assert.deepEqual(navigation(mode), { source: 'folders', lens: 'tags', media: 'images' });
  const restarted = createLocalFileMode();
  restarted.getState().setGeneratedFilter('source:generated');
  restarted.getState().setProjectContext('a');
  assert.deepEqual(navigation(restarted), { source: 'global', lens: 'flow', media: 'texts' });
  assert.equal(restarted.getState().browseProjectId, 'b');
  assert.equal(restarted.getState().generatedFilter, null);
});

test('source keys preserve the lens and Tab only toggles a logical lens', () => {
  const mode = createLocalFileMode();
  mode.getState().toggleCatalog();
  for (const [key, source] of [['E', 'project'], ['F', 'folders'], ['Q', 'global']]) {
    assert.equal(libraryShortcutSource(key), source);
    mode.getState().openSource(libraryShortcutSource(key));
    assert.deepEqual(navigation(mode), { source, lens: 'tags', media: 'images' });
    if (source === 'folders') mode.getState().toggleCatalog();
  }
  mode.getState().toggleCatalog();
  assert.deepEqual(navigation(mode), { source: 'global', lens: 'flow', media: 'images' });
});

test('panes restore their own navigation and inherit the previous project key until a selection', () => {
  saved.set('bowerbird.libraryProject.home', 'old-project');
  const left = createLocalFileMode('left'), right = createLocalFileMode('right');
  assert.equal(left.getState().browseProjectId, 'old-project');
  left.getState().openSource('folders');
  left.getState().selectProject('left-project');
  right.getState().setLens('tags');
  right.getState().selectProject('right-project');
  assert.deepEqual(navigation(createLocalFileMode('left')), { source: 'folders', lens: 'flow', media: 'images' });
  assert.deepEqual(navigation(createLocalFileMode('right')), { source: 'global', lens: 'tags', media: 'images' });
  assert.equal(createLocalFileMode('left').getState().browseProjectId, 'left-project');
  assert.equal(createLocalFileMode('right').getState().browseProjectId, 'right-project');
});

test('invalid storage falls back and unavailable writes preserve session memory', () => {
  saved.set('bowerbird.libraryView.main.home', '{"source":"unknown","lens":"unknown","media":"unknown"}');
  assert.deepEqual(navigation(createLocalFileMode()), { source: 'global', lens: 'flow', media: 'images' });
  localStorage.setItem = () => { throw new Error('storage unavailable'); };
  const mode = createLocalFileMode('memory-only');
  mode.getState().openSource('folders');
  mode.getState().setProjectContext('a');
  mode.getState().setLens('tags');
  mode.getState().selectProject('b');
  mode.getState().setProjectContext(null);
  assert.equal(mode.getState().source, 'folders');
  mode.getState().setProjectContext('a');
  assert.equal(mode.getState().lens, 'tags');
  assert.equal(mode.getState().browseProjectId, 'b');
});
