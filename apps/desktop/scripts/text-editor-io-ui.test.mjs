import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {PDFArray,PDFDict,PDFDocument,PDFName,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),cacheDir:'.tmp/text-editor-io-vite',plugins:process.env.BOWERBIRD_IO_DEBUG?[{name:'probe',enforce:'pre',transform(code,id){if(id.endsWith('/textEditorExport.tsx'))return code.replace('const html = await documentHtml(editor);','console.log("export html");const html = await documentHtml(editor);console.log("export frame");').replace('const doc = frame.contentDocument!;','console.log("frame loaded");const doc = frame.contentDocument!;').replace('await doc.fonts.ready;','await doc.fonts.ready;console.log("fonts ready");').replace("const { default: html2canvas }",'console.log("images ready");const { default: html2canvas }').replace('logging: false','logging: true').replace('return await html2canvas','console.log("html2canvas ready");return await html2canvas');}}]:[],server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:null}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
const coverage=[];let collecting=false;
async function collect(){if(collecting)coverage.push(...(await page.coverage.stopJSCoverage()).filter(e=>e.url.includes('/src/')));collecting=false;}
async function beginCoverage(){await collect();if(process.env.BOWERBIRD_DEMO_COVERAGE){await page.coverage.startJSCoverage();collecting=true;}}
const errors=[],notices=[];page.on('pageerror',e=>errors.push(e.message));await page.exposeFunction('notice',m=>notices.push(m));await page.addInitScript(()=>window.addEventListener('bowerbird://notify',e=>window.notice(e.detail)));
if(process.env.BOWERBIRD_IO_DEBUG)page.on('console',m=>console.log('CONSOLE',m.text()));
const editor=page.getByRole('textbox',{name:'文档正文',exact:true}),toolbar=page.getByRole('toolbar',{name:'文字格式',exact:true});
async function fresh(){await beginCoverage();await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-live/preview.html?markdown`,{timeout:60000});await editor.locator('[data-slate-node=element]').first().click();}
try{
await fresh();await page.context().grantPermissions(['clipboard-read','clipboard-write']);
await page.evaluate(text=>navigator.clipboard.writeText(text),'# 文档标题\n\n**粗体**与[链接](https://example.com)\n\n| A | B |\n| --- | --- |\n| one | two |\n\n- [ ] task\n\n```js\nconst answer = 42;\n```\n');await page.keyboard.press('Control+v');
await editor.locator('h1').waitFor();assert.equal(await editor.locator('table').count(),1);assert.match(await editor.innerText(),/answer = 42/);console.log('PASS Markdown paste preserves heading, marks, links, table, task and code');
await mkdir('.tmp/text-editor-io',{recursive:true});
for(const [label,ext,signature] of [['Markdown','md','#'],['HTML','html','<!doctype html>'],['图片','png','PNG'],['Word','docx','PK']]){
await toolbar.locator('[aria-label="导出"]').click();const download=page.waitForEvent('download',{timeout:60000});await page.getByRole('menuitem',{name:`导出 ${label}`,exact:true}).click();const d=await download;const path=`.tmp/text-editor-io/document.${ext}`;await d.saveAs(path);const bytes=await readFile(path);assert.ok(bytes.length>100);assert.ok(bytes.subarray(0,30).toString().includes(signature));console.log('PASS export',label,bytes.length);
if(ext==='html'){const content=bytes.toString();assert.match(content,/文档标题/);assert.doesNotMatch(content,/<script|fonts.googleapis|platejs.org/);}
}
await fresh();
const image = await page.evaluate(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 570;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#b5c5bb';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#435e64';
  ctx.fillRect(20, 20, canvas.width - 40, 12);
  ctx.fillRect(20, canvas.height - 32, canvas.width - 40, 12);
  return canvas.toDataURL('image/png');
});
const paragraph = '河岸静下来以后，远处仍有汽笛声。镜头沿着路灯向前移动，经过石阶、桥洞和亮着灯的店铺，最后停在渡口。';
const lines = Array.from({length: 49}, (_, i) => `${i + 1}. ${paragraph}`);
const table = '| 表格列一 | 表格列二 |\n| --- | --- |\n' + Array.from({length: 23}, (_, i) => `| 左列段落 ${i + 1} | 右列段落 ${i + 1} |`).join('\n');
await page.evaluate(text => navigator.clipboard.writeText(text), [
  '# 分页测试标题', 'PDF searchable text 中文检索', '公式 $\\sqrt{x^2+1}$', ...lines.slice(0, 18),
  `![完整分页图片](${image})`, table, ...lines.slice(18), '分页测试末尾',
].join('\n\n'));
await page.keyboard.press('Control+v');
await editor.locator('table').waitFor();
await editor.locator('img').waitFor();
await page.evaluate(() => { window.print = () => { window.printReady = true; }; });
await toolbar.locator('[aria-label="导出"]').click();
await page.getByRole('menuitem', {name:'导出 PDF',exact:true}).click();
await page.waitForFunction(() => window.printReady);
const printHost = page.locator('#bowerbird-document-print');
assert.equal(await printHost.isVisible(), false, 'print source remains out of the editor on screen');
await page.emulateMedia({media:'print'});
assert.equal(await printHost.isVisible(), true);
assert.equal(await page.locator('#root').isVisible(), false, 'app chrome is excluded from print');
assert.equal(await page.locator('html').evaluate(root => getComputedStyle(root).colorScheme), 'light');
const pdfBytes = await page.pdf({path:'.tmp/text-editor-io/document.pdf',preferCSSPageSize:true,printBackground:true});
await page.emulateMedia({media:null});
const pdf = await PDFDocument.load(pdfBytes);
assert.ok(pdf.getPageCount() >= 3);
let imageDraws = 0;
let equationFont = false;
for (const pdfPage of pdf.getPages()) {
  const { width, height } = pdfPage.getSize();
  assert.ok(Math.abs(width - 595.28) < 1 && Math.abs(height - 841.89) < 1, 'A4 page size');
  const contents = pdfPage.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map(ref => pdf.context.lookup(ref)) : [contents];
  const commands = streams.map(stream => {
    assert.ok(stream instanceof PDFRawStream);
    return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
  }).join('\n');
  assert.match(commands, /\bBT\b[\s\S]*\bT[Jj]\b/, 'each page contains selectable text operators');
  const fonts = pdfPage.node.Resources().lookup(PDFName.of('Font'), PDFDict);
  equationFont ||= fonts.entries().some(([, ref]) => pdf.context.lookup(ref, PDFDict).lookup(PDFName.of('BaseFont'), PDFName).asString().includes('KaTeX'));
  imageDraws += [...commands.matchAll(/\/\w+\s+Do\b/g)].length;
}
assert.equal(imageDraws, 1, 'the image is drawn once on a single page');
assert.equal(equationFont, true, 'KaTeX fonts are embedded in the PDF');
await printHost.waitFor({state:'detached'});
assert.match(await editor.innerText(), /分页测试末尾/);
console.log('PASS PDF uses paged vector text, A4 margins, a whole image and print cleanup', pdf.getPageCount());
await fresh();
await page.evaluate(async () => navigator.clipboard.write([new ClipboardItem({
  'text/plain': new Blob(['样式正文 有意强调'], { type: 'text/plain' }),
  'text/html': new Blob(['<p style="color:black;font-family:system-ui;font-size:16px"><b>样式正文</b><span style="color:red">有意强调</span></p>'], { type: 'text/html' }),
})]));
await page.keyboard.press('Control+v');
await page.waitForFunction(() => window.draft?.markdown?.includes('有意强调'));
const pasted = await page.evaluate(async () => {
  const { parseMarkdown, serializeReadableMarkdown } = await import('/src/lib/documentCodec.ts');
  const value = parseMarkdown(window.draft.markdown);
  return { leaves: value.flatMap(block => block.children), markdown: serializeReadableMarkdown(value) };
});
assert.ok(pasted.leaves.find(leaf => leaf.text === '样式正文')?.bold);
assert.ok(pasted.leaves.find(leaf => leaf.text === '有意强调')?.color);
assert.ok(pasted.leaves.every(leaf => !leaf.fontFamily && !leaf.fontSize));
assert.doesNotMatch(pasted.markdown, /<span|bowerbird-document/);
assert.deepEqual(errors,[]);assert.deepEqual(notices.filter(n=>n.tone==='error'),[]);
}finally{console.log('PAGE_ERRORS',errors,'NOTICES',notices);await page.screenshot({path:'.tmp/text-editor-io/current.png'});if(process.env.BOWERBIRD_DEMO_COVERAGE){await mkdir('.tmp/text-editor-io',{recursive:true});await writeFile('.tmp/text-editor-io/coverage.json',JSON.stringify((await collect(),coverage)));}await browser.close();await server.close();}
