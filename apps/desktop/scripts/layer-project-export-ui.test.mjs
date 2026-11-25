import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { initializeCanvas, readPsd } from 'ag-psd';
initializeCanvas(() => { throw new Error('Unexpected canvas allocation'); }, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
const server=await createServer({server:{host:'127.0.0.1',port:1582,strictPort:true,hmr:false,watch:null}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1550,height:1050}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto('http://127.0.0.1:1582/scripts/fixtures/layers/preview.html');
 await page.evaluate(() => {
  const doc = structuredClone(window.documentFixture);
  doc.layers[1].opacity = .45;
  doc.layers[2].text = { content: '可编辑文字\nBOWERBIRD', fontFamily: 'Arial', fontSize: 30, color: '#ff0000', bold: true,
   italic: true, underline: true, shadow: true, align: 'center', lineHeight: 1.2, letterSpacing: 2, boxWidth: 700, boxHeight: 100,
   runs: [{ start: 6, end: 15, fontFamily: 'SimSun', color: '#0000ff', strikethrough: true }] };
  doc.layers.push({ ...doc.layers[1], id: 'hidden', name: '隐藏图层', visible: false, x: -20 });
  sessionStorage.setItem('layer-workspace', JSON.stringify({ document: doc, pending: null }));
 });
 await page.reload();await page.getByRole('button',{name:'打开分层编辑',exact:true}).click();const dialog=page.getByRole('dialog',{name:'分层编辑',exact:true});await dialog.getByLabel('图层名称').waitFor();
 await page.evaluate(()=>window.cancelExport=true);await dialog.getByRole('button',{name:'导出 PSD',exact:true}).click();assert.equal(await page.evaluate(()=>window.fileExports?.length||0),0);
 await page.evaluate(()=>{window.cancelExport=false;window.failExport=true;});await dialog.getByRole('button',{name:'导出 PSD',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'模拟工程导出失败'}).waitFor();
 await page.evaluate(()=>window.failExport=false);await dialog.getByRole('button',{name:'导出 PSD',exact:true}).click();await page.waitForFunction(()=>window.fileExports?.length===1);
 const exported=await page.evaluate(()=>window.fileExports[0]);const bytes=Buffer.from(exported.args.base64,'base64');const psd=readPsd(bytes,{useImageData:true});
 assert.equal(psd.width,1024);assert.equal(psd.height,768);assert.deepEqual(psd.children.map(l=>l.name),['底图','圆形装饰','标题文字','隐藏图层']);assert.equal(psd.children[3].hidden,true);assert.equal(psd.children[3].left,-20);assert.ok(Math.abs(psd.children[1].opacity-.45)<.005);
 assert.equal(psd.children[2].text.text.trim(),'可编辑文字\nBOWERBIRD');assert.equal(psd.children[2].text.style.fontSize,30);assert.equal(psd.children[2].text.style.fauxBold,true);
 assert.equal(psd.children[2].text.styleRuns[0].style.font.name,'ArialMT','use native PostScript font identifiers');
 assert.equal(psd.children[2].text.style.fauxItalic, true);
 assert.equal(psd.children[2].text.style.underline, true);
 assert.equal(psd.children[2].text.styleRuns[1].style.font.name, 'SimSun');
 assert.equal(psd.children[2].text.styleRuns[1].style.strikethrough, true);
 assert.deepEqual(psd.children[2].text.styleRuns[1].style.fillColor, { r: 0, g: 0, b: 255 });
 assert.equal(psd.children[2].effects.dropShadow[0].enabled, true);
 assert.equal(psd.children[1].imageData.data[3],0,'transparent PNG corners remain transparent');
 const middle=(200*400+200)*4;assert.equal(psd.children[1].imageData.data[middle+3],255,'layer opacity remains separate from pixel alpha');
 assert.deepEqual([...psd.imageData.data.slice(0,4)],[238,233,220,255],'composite preview matches the background');
 await dialog.getByRole('button',{name:'导出 AI（需 Illustrator）',exact:true}).click();await page.waitForFunction(()=>window.fileExports?.length===2);const ai=await page.evaluate(()=>window.fileExports[1]);assert.equal(ai.args.document.layers[2].text.content,'可编辑文字\nBOWERBIRD');
 assert.equal(ai.args.document.layers[2].text.runs[0].strikethrough, true);
 const croppedLayers = await page.evaluate(async () => {
  const { exportBytesBase64, exportLayerPsd } = await import('/src/lib/layerExport.ts');
  const { layers, ...document } = window.documentFixture;
  const crops = Array.from({ length: 50 }, (_, i) => ({ ...layers[1], id: `crop-${i}`, name: `裁切图层 ${i}`, width: 32, height: 32 }));
  return exportBytesBase64(await exportLayerPsd({ ...document, layers: [layers[0], ...crops] }));
 });
 const croppedPsd = readPsd(Buffer.from(croppedLayers, 'base64'), { skipLayerImageData: true, skipCompositeImageData: true });
 assert.equal(croppedPsd.children.length, 51, 'large layer count can use the existing pixel budget');
 await assert.rejects(page.evaluate(async () => {
  const { exportLayerPsd } = await import('/src/lib/layerExport.ts');
  const { layers, ...document } = window.documentFixture;
  const largeLayers = Array.from({ length: 50 }, () => ({ ...layers[1], width: 2048, height: 2048 }));
  await exportLayerPsd({ ...document, layers: [layers[0], ...largeLayers] });
 }), /图层尺寸过大/);
 await mkdir('.tmp/layer-project-export',{recursive:true});await writeFile('.tmp/layer-project-export/sample.psd',bytes);await writeFile('.tmp/layer-project-export/document.json',JSON.stringify(ai.args.document));await page.screenshot({path:'.tmp/layer-project-export/panel.png'});
 assert.deepEqual(errors,[]);console.log('PASS PSD mixed editable styles, dimensions/layer order/hidden/alpha/position, 51 cropped layers and pixel cap, AI document handoff');
} finally {await browser.close();await server.close();}
