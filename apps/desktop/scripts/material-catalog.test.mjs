import test from 'node:test';
import assert from 'node:assert/strict';
import { orderCatalogTags, collectionRows, catalogInitial } from '../src/lib/materialCatalogOrder.ts';
const tag = (name, projectCount = 0, description = '') => ({ id:name, name, projectCount, description });

test('home uses pinyin; project ranks its prompt and asset signals without mutating tags', () => {
  const tags = [tag('建筑'),tag('插画'),tag('海报',2)];
  assert.deepEqual(orderCatalogTags(tags,['建筑空间'],false).map(t=>t.name),['插画','海报','建筑']);
  assert.deepEqual(orderCatalogTags(tags,['建筑空间'],true).map(t=>t.name),['建筑','海报','插画']);
  assert.deepEqual(orderCatalogTags(tags,[],true).map(t=>t.name),['海报','插画','建筑']);
  assert.deepEqual(tags.map(t=>t.name),['建筑','插画','海报']);
});
test('empty projects fall back to alphabetic and English phrases match word boundaries', () => {
  const tags = [tag('Zebra'), tag('Art'), tag('Pixel art')];
  assert.deepEqual(orderCatalogTags(tags,[],true).map(t=>t.name),['Art','Pixel art','Zebra']);
  const sorted = orderCatalogTags(tags,['A PIXEL ART drawing for a party'],true);
  assert.equal(sorted.find(t=>t.name==='Pixel art').nameMatch,true);
  assert.equal(orderCatalogTags([tag('Art')],['party'],true)[0].score,0);
});
test('description evidence requires multiple overlaps and tie order is stable', () => {
  const tags = [tag('B',0,'editorial illustration drawing'),tag('A',0,'editorial illustration drawing')];
  assert.equal(orderCatalogTags(tags,['editorial'],true)[0].score,0);
  const ranked = orderCatalogTags(tags,['editorial illustration'],true);
  assert.ok(ranked[0].score > 0); assert.equal(ranked[0].name,'A');
});
test('collection tree orders siblings and keeps nested paths, orphans and cycles reachable', () => {
  const rows = collectionRows([{id:'child',name:'子',parent_id:'root'},{id:'root',name:'根'},
    {id:'orphan',name:'孤',parent_id:'gone'},{id:'x',name:'X',parent_id:'y'},{id:'y',name:'Y',parent_id:'x'}]);
  assert.equal(rows.find(r=>r.item.id==='child').path,'根 / 子');
  assert.equal(rows.find(r=>r.item.id==='child').depth,1);
  assert.equal(new Set(rows.map(r=>r.item.id)).size,5);
});
test('Chinese and Latin initials share A-Z buckets, with symbols last', () => {
  for (const [name,initial] of [['标志','B'],['标题卡','B'],['包装','B'],['海报','H'],['字体排版','Z'],['Éditorial','E'],['Ｌogo','L'],['#插画','C'],['2026','#']]) assert.equal(catalogInitial(name),initial,name);
  const names=orderCatalogTags(['Zebra','海报','插画','Art','标志','标题卡','Icon','123'].map(n=>tag(n)),[],false).map(t=>t.name);
  assert.deepEqual(names,['Art','标题卡','标志','插画','海报','Icon','Zebra','123']);
});
test('manual pins precede both pinyin and relevance without changing unpinned order', () => {
  const tags=[tag('建筑'),tag('插画'),tag('海报',2),tag('字体')];
  assert.deepEqual(orderCatalogTags(tags,['建筑空间'],true,['字体','插画']).map(t=>t.name),['字体','插画','建筑','海报']);
  assert.deepEqual(orderCatalogTags(tags,[],false,['missing','字体']).map(t=>t.name),['字体','插画','海报','建筑']);
  assert.deepEqual(orderCatalogTags(tags,[],false,[]).map(t=>t.name),['插画','海报','建筑','字体']);
});
