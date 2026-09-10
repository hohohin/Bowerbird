import test from "node:test";
import assert from "node:assert/strict";
import { arrangeCanvasNodes } from "../src/lib/canvasArrangement.ts";

const node = (id, x = 0, y = 0, width = 190, height = 180, order = 1) => ({ id, order, rect: { x, y, width, height } });
const edge = (fromNodeId, toNodeId) => ({ fromNodeId, toNodeId });
function apply(nodes, positions) {
  return nodes.map(n => ({ ...n, rect: { ...n.rect, ...positions.get(n.id) } }));
}
function assertNoOverlaps(nodes) {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i].rect, b = nodes[j].rect;
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
      `${nodes[i].id} overlaps ${nodes[j].id}`);
  }
}

test("arrange follows branches and shared descendants without taking upstream or unrelated cards", () => {
  const nodes = [node('input', -400), node('prompt'), node('a'), node('b', 0, 0, 300, 350), node('next'), node('other', 240, 0)];
  const edges = [edge('input', 'prompt'), edge('prompt', 'a'), edge('prompt', 'b'), edge('a', 'next'), edge('b', 'next')];
  const positions = arrangeCanvasNodes(nodes, edges, ['prompt']);
  assert.deepEqual([...positions.keys()], ['prompt', 'a', 'b', 'next']);
  assert.equal(positions.get('a').x, positions.get('b').x);
  assert.ok(positions.get('next').x > positions.get('a').x);
  const result = apply(nodes, positions);
  assertNoOverlaps(result);
  assert.deepEqual(result.find(n => n.id === 'other'), nodes.find(n => n.id === 'other'));
  assert.deepEqual(arrangeCanvasNodes(result, edges, positions.keys()), positions);
});

test("multiple roots and selected descendants retain connection order", () => {
  const nodes = [node('root'), node('child'), node('leaf'), node('separate')];
  const edges = [edge('root', 'child'), edge('child', 'leaf')];
  const positions = arrangeCanvasNodes(nodes, edges, ['root', 'child', 'separate']);
  assert.equal(positions.size, 4);
  assert.ok(positions.get('child').x > positions.get('root').x);
  assert.ok(positions.get('leaf').x > positions.get('child').x);
  assertNoOverlaps(apply(nodes, positions));
});

test("obstacle chains, mixed dimensions, missing nodes and cycles remain bounded", () => {
  const nodes = [node('a', 0, 0, 350, 240), node('b'), node('obstacle1', 0, 30), node('obstacle2', 0, 260, 800, 100)];
  const positions = arrangeCanvasNodes(nodes, [edge('a', 'b'), edge('b', 'a'), edge('a', 'missing')], ['a']);
  assert.equal(positions.size, 2);
  assert.ok(positions.get('a').y >= 392);
  assertNoOverlaps(apply(nodes, positions));
  assert.deepEqual(arrangeCanvasNodes(nodes, [], ['missing']), new Map());
  assert.deepEqual(arrangeCanvasNodes(nodes, [], []), new Map());
});
