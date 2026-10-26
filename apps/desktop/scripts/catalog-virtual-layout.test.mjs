import {test} from 'node:test';
import assert from 'node:assert/strict';
import {catalogLayout,catalogScrollScale,masonryGeometry,visibleCatalogBlocks,CATALOG_PAGE_SIZE,CATALOG_GAP} from '../src/lib/catalogVirtualLayout.ts';

const section=(id,count)=>({id,name:id,count,tagId:id});
const assetsFor=ratios=>ratios.map(ratio=>({width:ratio,height:1}));
const measuredPages=(id,ratios)=>new Map(Array.from({length:Math.ceil(ratios.length/CATALOG_PAGE_SIZE)},(_,page)=>[
  `${id}:${page}`,ratios.slice(page*CATALOG_PAGE_SIZE,(page+1)*CATALOG_PAGE_SIZE),
]));
const close=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<1e-7,`${message}: ${actual} != ${expected}`);

function assertContinuous(ratios,available,target,measured=measuredPages('all',ratios)) {
  const assets=assetsFor(ratios);
  const expected=masonryGeometry(assets,available,target);
  const layout=catalogLayout([section('all',assets.length)],available,target,measured,false);
  for(const block of layout.blocks) {
    const page=masonryGeometry(assets.slice(block.offset,block.offset+block.count),available,target,block.columnTops);
    page.cells.forEach((cell,index)=>{
      const whole=expected.cells[block.offset+index];
      close(block.top+cell.top,whole.top,`asset ${block.offset+index} top`);
      close(cell.left,whole.left,`asset ${block.offset+index} left`);
      close(cell.height,whole.height,`asset ${block.offset+index} height`);
    });
  }
  close(layout.height,expected.height,'catalog height');
  return layout;
}
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
test('pages continue the same masonry columns as one uninterrupted layout at different widths',()=>{
  const ratios=Array.from({length:187},(_,index)=>[1,.25,2,1.5,.75,4,1/9][index%7]);
  for(const available of [330,481,1000]) assertContinuous(ratios,available,150);
});
test('fractional column heights retain deterministic ties when page coordinates become relative',()=>{
  const ratios=Array.from({length:1320},(_,index)=>(index+1)%60===0?.25:1);
  ratios[59]=1/80;
  const layout=assertContinuous(ratios,980,150);
  assert.equal(layout.blocks.length,22);
});
test('the next page fills short columns with the regular gap instead of waiting for the tallest image',()=>{
  const ratios=Array(61).fill(1); ratios[59]=.25;
  const layout=assertContinuous(ratios,800,240);
  const first=masonryGeometry(assetsFor(ratios.slice(0,60)),800,240);
  const next=masonryGeometry(assetsFor(ratios.slice(60)),800,240,layout.blocks[1].columnTops).cells[0];
  const preceding=first.cells.filter(cell=>cell.left===next.left).at(-1);
  close(layout.blocks[1].top+next.top-preceding.top-preceding.height,CATALOG_GAP,'page boundary gap');
  assert.ok(layout.blocks[1].top+next.top<Math.max(...first.cells.map(cell=>cell.top+cell.height)));
});
test('visibility retains a tall image from an earlier page while excluding intervening pages above the viewport',()=>{
  const ratios=Array(241).fill(1); ratios[0]=.001;
  const layout=assertContinuous(ratios,480,150);
  const top=layout.blocks[2].top+32;
  assert.ok(layout.blocks[0].top+layout.blocks[0].height>layout.blocks[2].top+layout.blocks[2].height);
  assert.deepEqual(visibleCatalogBlocks(layout.blocks,top,100,0).map(block=>block.key),['all:0','all:2']);
  assert.deepEqual(visibleCatalogBlocks(layout.blocks,layout.height-100,80,0).map(block=>block.key),['all:0']);
});
test('unknown pages estimate a continuous square layout and preserve loaded ratios before a random jump',()=>{
  const ratios=Array(135).fill(1);
  assertContinuous(ratios,1000,150,new Map());
  ratios.splice(0,60,...Array.from({length:60},(_,index)=>index%3?.5:3));
  const layout=assertContinuous(ratios,1000,150,new Map([['all:0',ratios.slice(0,60)]]));
  assert.equal(visibleCatalogBlocks(layout.blocks,layout.height-20,20,0).at(-1).offset,120);
});
test('historical ratio arrays are truncated or supplemented to the current page count',()=>{
  const ratios=Array.from({length:65},(_,index)=>[.25,1,2][index%3]);
  assertContinuous(ratios,980,150,new Map([
    ['all:0',[...ratios.slice(0,60),...Array(20).fill(.001)]],
    ['all:1',[...ratios.slice(60),...Array(30).fill(.001)]],
  ]));
  const partial=[.25,2,.5,...Array(57).fill(1),3,.125,1,1,1];
  assertContinuous(partial,980,150,new Map([
    ['all:0',partial.slice(0,3)],
    ['all:1',partial.slice(60,62)],
  ]));
});
test('section offsets incorporate loaded page ratios and retain independent duplicate memberships',()=>{
  const sections=[section('a',61),section('b',60)];
  const first=catalogLayout(sections,1000,150,new Map(),true);
  const changed=catalogLayout(sections,1000,150,new Map([['a:0',Array(60).fill(.5)]]),true);
  const expectedA=masonryGeometry(assetsFor([...Array(60).fill(.5),1]),1000,150);
  close(changed.groups[1].top,40+expectedA.height+16,'next section top');
  assert.ok(changed.groups[1].top>first.groups[1].top);
  close(changed.groups[1].height,first.groups[1].height,'unmeasured section height');
  assert.equal(changed.blocks[1].count,1); assert.equal(changed.blocks[2].key,'b:0');
});
test('empty sections and partial pages preserve section boundaries without inheriting another section columns',()=>{
  for(const headings of [false,true]) {
    const sections=[section('empty',0),section('one',1),section('short',17),section('last-empty',0)];
    const layout=catalogLayout(sections,330,150,new Map([['one:0',[.1]]]),headings);
    assert.deepEqual(layout.blocks.map(block=>[block.key,block.count]),[['one:0',1],['short:0',17]]);
    assert.deepEqual(layout.blocks[1].columnTops,[0,0]);
    close(layout.blocks[1].top,layout.groups[2].top+(headings?40:0)+8,'new section first cell');
    for(let index=1;index<layout.groups.length;index++) {
      close(layout.groups[index].top,layout.groups[index-1].top+layout.groups[index-1].height,'adjacent section boundary');
    }
    assert.equal(layout.groups[0].height,headings?56:0);
    assert.equal(layout.groups[3].height,headings?56:0);
  }
});
test('compressed scrollbar still reaches the last asset at very large logical heights',()=>{
  const height=150000000, viewport=720, scale=catalogScrollScale(height,viewport);
  assert.equal(catalogScrollScale(1000,viewport),1);
  assert.ok(Math.abs((8000000-viewport)/scale-(height-viewport))<.001);
});
