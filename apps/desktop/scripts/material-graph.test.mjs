import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMaterialGraph, fitGraph } from '../src/lib/materialGraph.ts';

test('a shared image is one node with two real membership edges',()=>{
  const image={id:'a',name:'Shared',thumb_path:null,store_path:null,tag_ids:['tag-a','tag-b','tag-a']};
  const graph=buildMaterialGraph([image,image,{...image,id:'b',tag_ids:[]}],[{id:'tag-a',name:'A',count:1},{id:'tag-b',name:'B',count:1},{id:'__catalog_untagged__',name:'未分类',count:1}]);
  assert.equal(graph.nodes.filter(n=>n.asset).length,2);
  assert.deepEqual(graph.edges.map(e=>[graph.nodes[e.source].tagId,graph.nodes[e.target].asset.id]),[['tag-a','a'],['tag-b','a'],['__catalog_untagged__','b']]);
  assert.equal(graph.nodes.filter(n=>n.id==='asset:a').length,1);
});
test('large topology stays complete and fits without argument-stack overflow',()=>{
  const sections=Array.from({length:80},(_,i)=>({id:`tag-${i}`,name:`Tag ${i}`,count:1000}));
  const assets=Array.from({length:80000},(_,i)=>({id:`asset-${i}`,name:'Image',thumb_path:null,store_path:null,tag_ids:[`tag-${i%80}`,`tag-${(i+1)%80}`]}));
  const graph=buildMaterialGraph(assets,sections);
  assert.equal(graph.nodes.length,80080); assert.equal(graph.edges.length,160000);
  const camera=fitGraph(graph.nodes,1280,800);
  assert.ok(Number.isFinite(camera.x+camera.y+camera.scale));
  for(const node of graph.nodes) { const x=node.x*camera.scale+camera.x,y=node.y*camera.scale+camera.y; assert.ok(x>=0&&x<=1280&&y>=0&&y<=800); }
});
