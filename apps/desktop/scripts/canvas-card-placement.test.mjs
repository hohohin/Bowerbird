import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasCardSourceRects, placeCanvasCardNearSource } from '../src/lib/canvasReferencePlacement.ts';

const overlaps = (a, b) => a.x < b.x + b.width + 32 && a.x + a.width + 32 > b.x
  && a.y < b.y + b.height + 32 && a.y + a.height + 32 > b.y;

test('a collision stays beside its source even when the source is far outside the viewport', () => {
  const card = { x: 10000, y: -5000, width: 260, height: 340 };
  const obstacle = { ...card };
  const far = { x: 90000, y: 80000, width: 10000, height: 10000 };
  const next = placeCanvasCardNearSource(card, [obstacle, far]);
  assert.deepEqual(next, { x: 10292, y: -5000 });
  assert.equal(overlaps({ ...card, ...next }, obstacle), false);
  assert.deepEqual(placeCanvasCardNearSource(card, [far, obstacle]), next);
  assert.deepEqual(placeCanvasCardNearSource(card, []), { x: 10000, y: -5000 });
});

test('repeated generations use nearby free positions and leave previous cards unchanged', () => {
  const card = { x: -600, y: 800, width: 260, height: 180 };
  const occupied = [{ x: -862, y: 800, width: 190, height: 500 }];
  for (let index = 0; index < 40; index++) {
    const before = structuredClone(occupied);
    const next = { ...card, ...placeCanvasCardNearSource(card, occupied) };
    assert.ok(occupied.every(other => !overlaps(next, other)));
    assert.ok(Math.hypot(next.x - card.x, next.y - card.y) < 2000);
    assert.deepEqual(occupied, before);
    occupied.push(next);
  }
});

test('folded results and grouped references anchor to their visible instances', () => {
  const card = { id: 'new', projectId: 'p', threadId: 't', kind: 'prompt' };
  const edges = ['result', 'group-member', 'fresh', 'gone'].map((fromNodeId, ordinal) =>
    ({ fromNodeId, toNodeId: card.id, projectId: 'p', threadId: 't', kind: 'input', ordinal }));
  edges.push({ ...edges[0], fromNodeId: 'unrelated', projectId: 'other' });
  const conversation = { x: 100, y: 200, width: 260, height: 340 };
  const group = { x: 500, y: 200, width: 548, height: 400 };
  const anchors = new Map([['conversation', conversation], ['group', group]]);
  const aliases = new Map([['result', 'conversation'], ['group-member', 'group']]);
  assert.deepEqual(canvasCardSourceRects(card, edges, anchors, aliases, new Set(['fresh'])), [conversation, group]);
  assert.deepEqual(canvasCardSourceRects(card, [...edges].reverse(), anchors, aliases, new Set(['fresh'])), [conversation, group]);
  const agent = { ...card, id: 'agent', kind: 'agent_group' };
  assert.deepEqual(canvasCardSourceRects(agent, [...edges, { ...edges[0], fromNodeId: 'new', toNodeId: 'agent' }],
    anchors, aliases, new Set(['fresh'])), [conversation, group]);
});
