import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createLocalFileMode } from '../src/lib/localFileMode.ts';

let saved;
beforeEach(() => {
  saved = new Map();
  globalThis.localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  };
});

test('media restores after restart per project and pane, including existing preferences without media', () => {
  saved.set('bowerbird.libraryView.main.home', JSON.stringify({ view: 'collections', tagSource: 'global' }));
  const mode = createLocalFileMode();
  assert.equal(mode.getState().media, 'images');
  for (const media of ['videos', 'audios', 'texts', 'images', 'all']) {
    mode.getState().setMedia(media);
    const restored = createLocalFileMode().getState();
    assert.equal(restored.media, media);
    assert.equal(restored.view, 'collections');
  }
  mode.getState().setProjectContext('a');
  mode.getState().setMedia('texts');
  const restarted = createLocalFileMode();
  restarted.getState().setGeneratedFilter('source:generated');
  restarted.getState().setProjectContext('a');
  assert.equal(restarted.getState().media, 'texts');
  assert.equal(restarted.getState().generatedFilter, null);
  restarted.getState().setProjectContext(null);
  assert.equal(restarted.getState().media, 'all');
  assert.equal(createLocalFileMode('other-pane').getState().media, 'images');
});

test('reopening restores each primary tab and the tag scope without reopening transient menus', () => {
  for (const view of ['collections', 'project', 'tags', 'global']) {
    const mode = createLocalFileMode(view);
    mode.getState().setView(view);
    if (view === 'tags') mode.getState().setTagSource('project');
    mode.getState().selectProject('chosen-project');
    mode.getState().setOpen(false);
    const restored = createLocalFileMode(view).getState();
    assert.equal(restored.view, view);
    assert.equal(restored.mode, view === 'collections' || view === 'tags' ? view : 'all');
    assert.equal(restored.source, view === 'project' || view === 'tags' ? 'project' : 'global');
    assert.equal(restored.browseProjectId, 'chosen-project');
    assert.equal(restored.open, false);
    assert.equal(restored.scopeMenuOpen, false);
    assert.equal(restored.projectPickerOpen, false);
  }
});

test('home and each canvas restore their own tab and tag scope across navigation and restart', () => {
  const mode = createLocalFileMode('main');
  mode.getState().setView('collections');
  mode.getState().setProjectContext('a');
  assert.equal(mode.getState().view, 'project');
  mode.getState().setView('tags');
  mode.getState().setTagSource('global');
  mode.getState().setProjectContext('b');
  assert.equal(mode.getState().view, 'project');
  mode.getState().setView('global');
  mode.getState().setProjectContext('a');
  assert.equal(mode.getState().view, 'tags');
  assert.equal(mode.getState().source, 'global');
  mode.getState().setProjectContext(null);
  assert.equal(mode.getState().view, 'collections');
  const restarted = createLocalFileMode('main');
  assert.equal(restarted.getState().view, 'collections');
  restarted.getState().setProjectContext('a');
  assert.equal(restarted.getState().view, 'tags');
  assert.equal(restarted.getState().tagSource, 'global');
});

test('independent panes do not overwrite each other and explicit source shortcuts remain intentional', () => {
  const left = createLocalFileMode('left'), right = createLocalFileMode('right');
  left.getState().setView('collections');
  right.getState().setView('tags');
  assert.equal(createLocalFileMode('left').getState().view, 'collections');
  assert.equal(createLocalFileMode('right').getState().view, 'tags');
  left.getState().openSource('project');
  assert.equal(createLocalFileMode('left').getState().view, 'project');
  assert.equal(createLocalFileMode('right').getState().view, 'tags');
});

test('unavailable storage keeps in-session context memory and invalid stored choices use defaults', () => {
  const originalGet = localStorage.getItem;
  localStorage.getItem = () => '{"view":"unknown","tagSource":"unknown"}';
  assert.equal(createLocalFileMode('invalid').getState().view, 'global');
  localStorage.getItem = originalGet;
  localStorage.setItem = () => { throw new Error('storage unavailable'); };
  const mode = createLocalFileMode('memory-only');
  mode.getState().setView('collections');
  mode.getState().setProjectContext('a');
  mode.getState().setView('tags');
  mode.getState().setProjectContext(null);
  assert.equal(mode.getState().view, 'collections');
  mode.getState().setProjectContext('a');
  assert.equal(mode.getState().view, 'tags');
});
