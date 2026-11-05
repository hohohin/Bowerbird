import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ root:fileURLToPath(new URL('..',import.meta.url)), plugins: process.env.BOWERBIRD_TEXT_MUTATION ? [{name:'isolated-text-mutation',enforce:'pre',load(id){if(id.replaceAll('\\','/').endsWith('/'+process.env.BOWERBIRD_TEXT_TARGET)) return readFile(process.env.BOWERBIRD_TEXT_MUTATION,'utf8');}}] : [], server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:null} });
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1440,height:900}});
page.setDefaultTimeout(5000);
const failures=[];
const errors=[]; page.on('pageerror',error=>errors.push(error.message));
const coverage=process.env.BOWERBIRD_TEXT_COVERAGE==='1', coverageEntries=[];
if(coverage)await page.coverage.startJSCoverage({resetOnNavigation:false});
const editor=page.getByRole('textbox',{name:'文档正文',exact:true});
const floating=page.getByRole('toolbar',{name:'选中文字格式',exact:true});
async function check(name,action){try{
  if(coverage && page.url()!=='about:blank'){coverageEntries.push(...await page.coverage.stopJSCoverage());await page.coverage.startJSCoverage({resetOnNavigation:false});}
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-live/preview.html?markdown`);
  await editor.waitFor(); await editor.locator('.text-document-block').first().click();
  await action(); console.log('PASS',name);
}catch(error){failures.push(name+': '+error.stack); if(process.env.BOWERBIRD_TEXT_DEBUG)console.log(await page.evaluate(()=>({html:document.querySelector('.text-document-body')?.innerHTML,selection:window.getSelection()?.toString(),draft:window.draft,bar:document.querySelector('.text-selection-toolbar')?.getBoundingClientRect().toJSON(),body:document.querySelector('.text-document-body')?.getBoundingClientRect().toJSON()})));}}
try {
await check('headings convert at block start; Enter returns to body; undo restores marker',async()=>{
  for(let level=1;level<=3;level++){
    await page.keyboard.type('#'.repeat(level)+' ');
    assert.equal(await editor.locator('h'+level).count(),1);
    await page.keyboard.type('Title '+level); await page.keyboard.press('Enter');
  }
  await page.keyboard.type('body # text');
  assert.equal(await editor.locator('h3').innerText(),'Title 3');
  await page.keyboard.press('Enter'); await page.keyboard.type('# ');
  await page.keyboard.press('Control+z');
  assert.equal(await editor.locator('h1').count(),1);
  assert.match(await editor.locator('.text-document-block').last().innerText(),/#/);
});
await check('bullet and ordered lists continue and exit on empty Enter',async()=>{
  await page.keyboard.type('- one'); await page.keyboard.press('Enter'); await page.keyboard.type('two');
  assert.equal(await editor.locator('ul').count(),2);
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.type('body');
  assert.equal(await editor.locator('ul').count(),2);
  await page.keyboard.press('Enter'); await page.keyboard.type('1. first');
  await page.keyboard.press('Enter'); await page.keyboard.type('second');
  assert.equal(await editor.locator('ol').count(),2);
  assert.match(await page.evaluate(()=>window.draft.markdown),/1\. first\n2\. second/);
});
await check('quote and inline Markdown retain formatting after reopening',async()=>{
  await page.keyboard.type('> quote'); assert.equal(await editor.locator('blockquote').count(),1);
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await page.keyboard.type('**bold** *italic* `code`');
  assert.equal(await editor.locator('strong').innerText(),'bold');
  assert.equal(await editor.locator('em').innerText(),'italic');
  assert.equal(await editor.locator('code [data-slate-string]').innerText(),'code');
  await page.getByRole('button',{name:'返回',exact:true}).click();
  await page.getByRole('button',{name:'放大编辑',exact:true}).click();
  assert.equal(await editor.locator('strong').innerText(),'bold');
  assert.equal(await editor.locator('code [data-slate-string]').innerText(),'code');
});
await check('selection toolbar preserves selection and toggles marks',async()=>{
  await page.keyboard.type('selected text'); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
  await floating.waitFor();
  await floating.getByRole('button',{name:'加粗',exact:true}).click();
  assert.equal(await editor.locator('strong').innerText(),'selected text');
  assert.equal(await floating.getByRole('button',{name:'加粗',exact:true}).getAttribute('aria-pressed'),'true');
  await floating.getByRole('button',{name:'斜体',exact:true}).click();
  assert.equal(await editor.locator('em').innerText(),'selected text');
  await floating.getByRole('button',{name:'加粗',exact:true}).click();
  assert.equal(await editor.locator('strong').count(),0);
  await page.keyboard.press('Escape');
  await floating.waitFor({state:'hidden'});
  assert.equal(await page.getByRole('dialog',{name:'文本编辑器',exact:true}).count(),1);
  await page.keyboard.press('ArrowRight'); await page.keyboard.type('!');
  assert.match(await page.evaluate(()=>window.draft.markdown),/selected text/);
});
await check('toolbar scoped to editor; fixed list button toggles off',async()=>{
  await page.keyboard.type('line'); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
  await floating.waitFor();
  const fixed=page.getByRole('toolbar',{name:'文字格式',exact:true});
  await fixed.getByRole('button',{name:'列表',exact:true}).click();
  assert.equal(await editor.locator('ul').count(),1);
  await fixed.getByRole('button',{name:'列表',exact:true}).click();
  assert.equal(await editor.locator('ul').count(),0);
  await page.getByRole('textbox',{name:'文档名称',exact:true}).click();
  await floating.waitFor({state:'hidden'});
});
await check('keyboard selection across blocks; keyboard toolbar; scroll hides offscreen selection',async()=>{
  await page.keyboard.type('first'); await page.keyboard.press('Enter'); await page.keyboard.type('second');
  await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+Shift+End');
  await floating.waitFor(); await page.keyboard.press('Alt+F10');
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  assert.deepEqual(await editor.locator('strong').allTextContents(),['first','second']);
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
  for(let n=0;n<24;n++){await page.keyboard.type('paragraph '+n);await page.keyboard.press('Enter');}
  await page.keyboard.press('Control+Home'); await page.keyboard.press('Shift+End');
  await floating.waitFor();
  await editor.evaluate(element=>{element.scrollTop=element.scrollHeight;});
  await floating.waitFor({state:'hidden'});
});
await check('Chinese composition and literal mid-line Markdown',async()=>{
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});
  await floating.waitFor({state:'hidden'});
  await cdp.send('Input.insertText',{text:'中文'});
  await page.keyboard.type(' # text - text');
  assert.equal(await editor.locator('h1,ul').count(),0);
  assert.match(await page.evaluate(()=>window.draft.markdown),/中文 # text - text/);
  await cdp.detach();
});
await check('shared heading and quote buttons toggle; bold and italic keyboard shortcuts',async()=>{
  await page.keyboard.type('format me'); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
  await floating.waitFor();
  await floating.getByRole('button',{name:'标题',exact:true}).click();
  assert.equal(await editor.locator('h2').innerText(),'format me');
  await floating.getByRole('button',{name:'标题',exact:true}).click();
  assert.equal(await editor.locator('h2').count(),0);
  await floating.getByRole('button',{name:'引用',exact:true}).click();
  assert.equal(await editor.locator('blockquote').innerText(),'format me');
  await floating.getByRole('button',{name:'引用',exact:true}).click();
  assert.equal(await editor.locator('blockquote').count(),0);
  await page.keyboard.press('Control+b'); await page.keyboard.press('Control+i');
  assert.equal(await editor.locator('strong em,em strong').innerText(),'format me');
});
await check('original asset detail shares toolbar; raw blocks remain literal',async()=>{
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-library/preview.html`);
  await page.getByRole('button',{name:'源码',exact:true}).click();
  await page.getByRole('textbox',{name:'Markdown 源码',exact:true}).fill('```md\n# example\n```\n\nplain');
  await page.getByRole('button',{name:'正文',exact:true}).click();
  await editor.locator('pre [data-slate-string]').click(); await page.keyboard.press('Home'); await page.keyboard.type('# ');
  assert.equal(await editor.locator('h1').count(),0);
  await editor.locator('.text-document-block').last().click(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
  await floating.waitFor(); await floating.getByRole('button',{name:'行内代码',exact:true}).click();
  assert.equal(await editor.locator('code [data-slate-string]').innerText(),'plain');
});
await check('floating toolbar stays inside writing panel at narrow width and both themes',async()=>{
  await page.setViewportSize({width:900,height:700});
  await page.keyboard.type('Selected near the first line'); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
  await floating.waitFor();
  await page.waitForFunction(()=>{const bar=document.querySelector('.text-selection-toolbar').getBoundingClientRect(),body=document.querySelector('.text-document-body').getBoundingClientRect();return bar.left>=body.left && bar.right<=body.right;});
  const bar=await floating.boundingBox(), body=await editor.boundingBox();
  assert.ok(bar.x>=body.x && bar.x+bar.width<=body.x+body.width);
  assert.ok(bar.y>=body.y);
  await mkdir('.tmp/text-markdown',{recursive:true});
  for(const theme of ['dark','light']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.screenshot({path:`.tmp/text-markdown/${theme}.png`});
  }
});
assert.deepEqual(failures,[]);
assert.deepEqual(errors,[]);
}finally{
  if(coverage){coverageEntries.push(...await page.coverage.stopJSCoverage());await mkdir('.tmp/text-markdown',{recursive:true});await writeFile('.tmp/text-markdown/coverage.json',JSON.stringify(coverageEntries.filter(entry=>/\/src\/components\/(TextInputRules|TextFormatToolbar|TextPlateEditor)\./.test(entry.url))));}
  await browser.close();await server.close();
}
