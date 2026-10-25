import assert from 'node:assert/strict';
import test from 'node:test';
import { assignCanvasCardNames } from '../src/lib/canvasCardNames.ts';

test('video defaults use a separate name sequence and migrate old image defaults without collisions', () => {
  const previous = { image: '图片卡片 1', video: '图片卡片 2', existing: '视频卡片 1' };
  const cards = [{ id: 'image', title: '图片卡片' }, { id: 'video', title: '视频卡片' }, { id: 'existing', title: '视频卡片' }, { id: 'new', title: '视频卡片' }];
  const names = assignCanvasCardNames(previous, cards);
  assert.deepEqual(names, { image: '图片卡片 1', existing: '视频卡片 1', video: '视频卡片 2', new: '视频卡片 3' });
  assert.deepEqual(assignCanvasCardNames(names, cards), names, 'reload is stable');
  assert.equal(previous.video, '图片卡片 2', 'the input snapshot is not mutated');
});

test('custom video names and missing-media titles remain intact', () => {
  const previous = { custom: '产品视频终稿', missing: '视频卡片 4', similar: '图片卡片 2 修改版' };
  assert.deepEqual(assignCanvasCardNames(previous, [{ id: 'custom', title: '视频卡片' }, { id: 'missing', title: '图片卡片' }, { id: 'similar', title: '视频卡片' }]), previous);
});
