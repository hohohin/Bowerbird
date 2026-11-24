import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const output = '.tmp/file-previews/target';
const server = await createServer({cacheDir:`${output}/vite`,server:{host:'127.0.0.1',port:1688,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const errors = [];
try {
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  page.on('pageerror', error => errors.push(error.message));
  const url = 'http://127.0.0.1:1688/scripts/fixtures/folder-mode/preview.html';
  const openBrowser = () => page.evaluate(() => { window.mode.getState().setMode('files'); window.mode.getState().setOpen(true); });
  const previewCalls = () => page.evaluate(() => window.calls.filter(call => call.command === 'external_files_preview').map(call => call.args.path));
  await page.goto(url);
  await page.evaluate(() => { window.directoryCache = true; });
  await openBrowser();
  const photo = page.getByRole('button',{name:'photo.png',exact:true});
  await photo.locator('img').waitFor();
  assert.deepEqual(await previewCalls(), [], 'warm first screen uses directory thumbnails without extraction IPC');
  await page.waitForFunction(() => [...document.querySelectorAll('.folder-media-card img')].every(img => img.complete && img.naturalWidth > 0));
  await page.waitForTimeout(450); // Existing masonry width transitions must settle for the screenshot.
  await mkdir(output,{recursive:true});
  await page.screenshot({path:`${output}/warm-directory.png`});
  // A new version is a miss, but revisiting an unchanged directory reuses session previews.
  await page.evaluate(() => { window.directoryCache = false; window.previewVersion = '2'; window.previewDelay = 30; });
  await page.getByRole('button',{name:'刷新文件夹'}).click();
  await page.waitForFunction(() => window.calls.filter(call => call.command==='external_files_preview').length >= 2);
  await photo.locator('img').waitFor();
  await page.getByRole('button',{name:'clip.mp4',exact:true}).locator('img').waitFor();
  await page.getByRole('button',{name:'文件夹 旅行',exact:true}).dblclick();
  await page.getByRole('button',{name:'other.png',exact:true}).locator('img').waitFor();
  assert.deepEqual((await previewCalls()).slice(-1), ['/pictures/sub/other.png']);
  await page.evaluate(() => { window.previewGate = () => new Promise(() => {}); });
  await page.getByRole('button',{name:'返回上次目录'}).click();
  await photo.locator('img').waitFor({ timeout: 3000 }); // Cached preview renders while background metadata recovery is held.

  // Exercise native observer geometry inside an overflow viewport and saturate the four-worker queue.
  await page.addInitScript(() => {
    const NativeObserver = window.IntersectionObserver;
    window.previewRanges = new Map();
    window.previewObservers = [];
    window.IntersectionObserver = class extends NativeObserver {
      constructor(callback, options) {
        super((entries, observer) => {
          const range = window.previewRanges.get(observer.rootMargin) ?? new Map();
          for (const entry of entries) range.set(entry.target.dataset.filePath, entry.isIntersecting);
          window.previewRanges.set(observer.rootMargin, range);
          callback(entries, observer);
        }, options);
        window.previewObservers.push(this);
      }
    };
  });
  await page.goto(url);
  const blockers = Array.from({ length: 4 }, (_, index) => `/pictures/blocker-${index}.png`);
  const nearby = '/pictures/nearby.png';
  const promoted = '/pictures/promoted.png';
  const cancelled = '/pictures/cancelled.png';
  const visibleRange = '0px 0px 0px 0px';
  const prefetchRange = '400px 400px 400px 400px';
  await page.addStyleTag({ content: `
    .folder-scroller { height: 120px !important; flex: 0 0 120px !important; }
    .folder-masonry { height: 1400px !important; }
    .folder-media-card[data-file-path] { position: absolute !important; width: 70px !important; height: 60px !important; transform: none !important; }
    ${blockers.map((path, index) => `[data-file-path="${path}"] { top: 12px !important; left: ${12 + index * 76}px !important; }`).join('\n')}
    [data-file-path="${nearby}"] { top: 230px !important; left: 12px !important; }
    [data-file-path="${promoted}"] { top: 350px !important; left: 12px !important; }
    [data-file-path="${cancelled}"] { top: 740px !important; left: 12px !important; }
  ` });
  await page.evaluate(paths => {
    window.previewEntries = paths.map(path => ({ path, name: path.split('/').pop(), directory: false }));
    window.previewReleases = new Map();
    window.previewGate = path => new Promise(resolve => window.previewReleases.set(path, resolve));
  }, [nearby, promoted, ...blockers, cancelled]);
  await openBrowser();
  await page.waitForFunction(paths => paths.every(path => window.previewReleases.has(path)), blockers);
  assert.deepEqual(await previewCalls(), blockers, 'visible previews fill the workers ahead of nearby items');
  assert.deepEqual(await page.evaluate(() => window.previewObservers.filter(observer => observer.root === document.querySelector('.folder-scroller')).map(observer => observer.rootMargin).sort()),
    [visibleRange, prefetchRange], 'the scroll viewport has two shared observers');
  const waitForRange = (margin, path, inside) => page.waitForFunction(([key, path, inside]) => window.previewRanges.get(key)?.get(path) === inside, [margin, path, inside]);
  await waitForRange(prefetchRange, nearby, true);
  await waitForRange(visibleRange, nearby, false);
  await waitForRange(prefetchRange, cancelled, false);
  const scroller = page.locator('.folder-scroller');
  await scroller.evaluate(element => { element.scrollTop = 330; });
  await waitForRange(visibleRange, promoted, true);
  await waitForRange(prefetchRange, cancelled, true);
  await page.evaluate(path => window.previewReleases.get(path)(), blockers[0]);
  await page.waitForFunction(path => window.previewReleases.has(path), promoted);
  assert.deepEqual(await previewCalls(), [...blockers, promoted], 'queued work moves ahead when it enters the visible viewport');
  await scroller.evaluate(element => { element.scrollTop = 0; });
  await waitForRange(prefetchRange, cancelled, false);
  await page.evaluate(path => window.previewReleases.get(path)(), promoted);
  await page.waitForFunction(path => window.previewReleases.has(path), nearby);
  await page.evaluate(path => window.previewReleases.get(path)(), nearby);
  const released = [...blockers.slice(1), nearby];
  await page.evaluate(paths => { paths.forEach(path => window.previewReleases.get(path)()); }, blockers.slice(1));
  await page.waitForFunction(paths => paths.every(path => document.querySelector(`[data-file-path="${path}"] img`)), released);
  assert.deepEqual(await previewCalls(), [...blockers, promoted, nearby], 'nearby work starts before entering the viewport and pending off-range work is cancelled');
  assert.deepEqual(errors, []);
  console.log('PASS warm first screen, cold version refresh, warm revisit, and shared 400px preview scheduling');
} finally { await browser.close(); await server.close(); }
