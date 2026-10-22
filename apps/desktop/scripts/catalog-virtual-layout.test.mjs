import {test} from 'node:test';
import assert from 'node:assert/strict';
import {catalogLayout,catalogScrollScale,masonryGeometry,visibleCatalogBlocks,CATALOG_PAGE_SIZE} from '../src/lib/catalogVirtualLayout.ts';
test('300k layout supports last-page lookup without creating per-asset layout objects',()=>{
  const layout=catalogLayout([{id:'all',name:'',count:300000,tagId:null}],1200,150,new Map(),false);
  assert.equal(layout.blocks.length,300000/CATALOG_PAGE_SIZE);
  assert.equal(visibleCatalogBlocks(layout.blocks,layout.height-500,500).at(-1).offset,299940);
  assert.ok(visibleCatalogBlocks(layout.blocks,layout.height*.5,800).length<5);
});
test('masonry uses aspect ratios, deterministic positions and nonoverlapping columns',()=>{
  const g=masonryGeometry([{width:100,height:200},{width:200,height:100},{width:100,height:100},{width:100,height:400}],330,150);
  assert.equal(g.columns,2); assert.equal(g.cells[2].left,g.cells[1].left);
  assert.equal(g.cells[2].top,g.cells[1].top+g.cells[1].height+8);
  assert.ok(g.height>=Math.max(...g.cells.map(c=>c.top+c.height)));
});
test('section offsets incorporate loaded page heights and retain independent duplicate memberships',()=>{
  const sections=[{id:'a',name:'A',count:61,tagId:'a'},{id:'b',name:'B',count:60,tagId:'b'}];
  const first=catalogLayout(sections,1000,150,new Map(),true);
  const changed=catalogLayout(sections,1000,150,new Map([['a:0',first.blocks[0].height+100]]),true);
  assert.equal(changed.groups[1].top-first.groups[1].top,100);
  assert.equal(changed.blocks[1].count,1); assert.equal(changed.blocks[2].key,'b:0');
});
test('compressed scrollbar still reaches the last asset at very large logical heights',()=>{
  const height=150000000, viewport=720, scale=catalogScrollScale(height,viewport);
  assert.equal(catalogScrollScale(1000,viewport),1);
  assert.ok(Math.abs((8000000-viewport)/scale-(height-viewport))<.001);
});
