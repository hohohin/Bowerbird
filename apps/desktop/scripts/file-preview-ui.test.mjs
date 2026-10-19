import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({server:{host:'127.0.0.1',port:1688,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const errors = [];
try {
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:1688/scripts/fixtures/folder-mode/preview.html');
  await page.evaluate(() => { window.directoryCache = true; window.previewDelay = 3000; });
  await page.getByRole('tab',{name:'全局素材',exact:true}).click();
  await page.getByRole('tab',{name:'文件浏览器',exact:true}).click();
  const photo = page.getByRole('button',{name:'photo.png',exact:true});
  await photo.locator('img').waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command==='external_files_preview').length), 0, 'warm first screen uses directory thumbnails without extraction IPC');
  await page.waitForFunction(() => [...document.querySelectorAll('.folder-media-card img')].every(img => img.complete && img.naturalWidth > 0));
  await page.waitForTimeout(450); // Existing masonry width transitions must settle for the screenshot.
  await mkdir('.tmp/file-previews',{recursive:true});
  await page.screenshot({path:'.tmp/file-previews/warm-directory.png'});
  // A new version is a miss, but revisiting an unchanged directory reuses session previews.
  await page.evaluate(() => { window.directoryCache = false; window.previewVersion = '2'; window.previewDelay = 30; });
  await page.getByRole('button',{name:'刷新文件夹'}).click();
  await page.waitForFunction(() => window.calls.filter(call => call.command==='external_files_preview').length >= 2);
  await photo.locator('img').waitFor();
  await page.getByRole('button',{name:'clip.mp4',exact:true}).locator('img').waitFor();
  const before = await page.evaluate(() => window.calls.filter(call => call.command==='external_files_preview').length);
  await page.getByRole('button',{name:'文件夹 旅行',exact:true}).dblclick();
  await page.getByRole('button',{name:'other.png',exact:true}).locator('img').waitFor();
  await page.getByRole('button',{name:'返回上次目录'}).click();
  await photo.locator('img').waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command==='external_files_preview').length), before+1);
  assert.deepEqual(errors, []);
  console.log('Warm first screen: zero extraction IPC; cold version refresh and warm revisit passed.');
} finally { await browser.close(); await server.close(); }
