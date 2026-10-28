import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { __test as douyin } from '../lib/douyin.mjs';

const ID = '1234567890123456';
const MEDIA = 'https://v1.douyinvod.com/original?watermark=1';
const detail = (id = ID) => ({ aweme_id: id, desc: '合成参考作品', video: { duration: 5000, play_addr: { url_list: [MEDIA] } } });

test('share input resolves exactly one HTTPS target and canonicalizes supported forms', () => {
  assert.equal(douyin.parseShareUrl('分享 https://v.douyin.com/abc_12/ 复制打开'), 'https://v.douyin.com/abc_12/');
  for (const url of [`https://www.douyin.com/?modal_id=${ID}`, `https://www.iesdouyin.com/share/video/${ID}/`, `https://www.douyin.com/video/${ID}`]) {
    assert.equal(douyin.parseShareUrl(url), `https://www.douyin.com/video/${ID}`);
  }
  for (const input of ['http://v.douyin.com/abc/', 'https://v.douyin.com.evil.test/abc/',
    'https://u:p@v.douyin.com/abc/', 'https://v.douyin.com:444/abc/',
    'https://v.douyin.com/abc/ https://v.douyin.com/def/', 'https://www.douyin.com/user/abc',
    'https://live.douyin.com/1234', `https://www.douyin.com/note/${ID}`, 'a'.repeat(8001)]) {
    assert.throws(() => douyin.parseShareUrl(input));
  }
});

test('media URL and public DNS checks reject local, disguised, and unsafe destinations', () => {
  assert.equal(douyin.mediaUrl('//v1.douyinvod.com/original').protocol, 'https:');
  for (const url of ['http://v1.douyinvod.com/a', 'https://douyinvod.com.evil.test/a',
    'https://127.0.0.1/a', 'https://v1.douyinvod.com:444/a', 'https://u:p@v1.douyinvod.com/a']) {
    assert.throws(() => douyin.mediaUrl(url));
  }
  for (const ip of ['127.0.0.1', '10.1.1.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1',
    '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1']) {
    assert.equal(douyin.publicIp(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(douyin.publicIp(ip), true, ip);
});

test('selection requires target identity and rejects image/live/DRM/long works', () => {
  const good = { videoId: ID, duration: 5, urls: ['https://unsupported.example/file', MEDIA] };
  assert.deepEqual(douyin.selected(good, ID).urls, [MEDIA]);
  assert.throws(() => douyin.selected(good, '9999999999999999'), /目标/);
  for (const patch of [{ blocked: 'image' }, { blocked: 'protected' }, { blocked: 'live' },
    { duration: 121 }, { duration: NaN }, { urls: Array(7).fill(MEDIA) }]) {
    assert.throws(() => douyin.selected({ ...good, ...patch }, ID));
  }
});

test('unmodified application observer ignores feed items and preserves original media URLs', async () => {
  const source = await readFile(new URL('../lib/vendor/douyin_capture.js', import.meta.url), 'utf8');
  const original = await readFile(new URL('../../../apps/desktop/src-tauri/src/commands/video_replication/douyin_capture.js', import.meta.url), 'utf8');
  assert.equal(source, original);
  const location = { href: `https://www.douyin.com/video/${ID}`, pathname: `/video/${ID}` };
  const window = { fetch: async () => ({}) };
  window.top = window;
  function XHR() {} XHR.prototype.open = () => {};
  runInNewContext(source.replace('__EXPECTED_ID__', JSON.stringify(ID)), { window, location,
    navigator: { userAgent: 'offline-fixture' }, document: { getElementById: () => null }, XMLHttpRequest: XHR,
    URL, setInterval: () => 1, clearInterval: () => {} });
  window.__bbDouyinInspect({ aweme_detail: detail('9999999999999999') });
  assert.equal(window.__bbDouyinResult, undefined);
  window.fetch = async () => ({}); // Network observer remains useful if the site replaces fetch.
  window.__bbDouyinInspect({ aweme_detail: detail() });
  assert.equal(window.__bbDouyinResult.videoId, ID);
  assert.equal(window.__bbDouyinResult.duration, 5);
  assert.deepEqual(Array.from(window.__bbDouyinResult.urls), [MEDIA]);
});

test('Chromium fixture observes the intended work and keeps media paused without external requests', async () => {
  const chromium = await douyin.loadChromium();
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-background-networking'] });
  try {
    const context = await browser.newContext();
    const capture = await readFile(new URL('../lib/vendor/douyin_capture.js', import.meta.url), 'utf8');
    const quiet = await readFile(new URL('../lib/vendor/douyin_quiet.js', import.meta.url), 'utf8');
    assert.equal(quiet, await readFile(new URL('../../../apps/desktop/src-tauri/src/commands/video_replication/douyin_quiet.js', import.meta.url), 'utf8'));
    await context.addInitScript(quiet);
    await context.addInitScript(capture.replace('__EXPECTED_ID__', JSON.stringify(ID)));
    // The complete page is fulfilled in memory; every other network request is aborted.
    const pageUrl = `https://www.douyin.com/video/${ID}`;
    await context.route('**/*', route => route.request().url() === pageUrl
      ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<video autoplay muted></video><script>window._ROUTER_DATA=${JSON.stringify({ detail: detail() })}</script>` })
      : route.abort());
    const page = await context.newPage();
    await page.goto(pageUrl);
    await page.waitForFunction(() => Boolean(window.__bbDouyinResult));
    const result = await page.evaluate(() => window.__bbDouyinResult);
    assert.equal(result.videoId, ID);
    assert.deepEqual(result.urls, [MEDIA]);
    assert.equal(await page.locator('video').evaluate(video => video.play().then(() => 'played', error => error.name)), 'NotAllowedError');
    assert.deepEqual(await page.locator('video').evaluate(video => ({ muted: video.muted, paused: video.paused, autoplay: video.autoplay })),
      { muted: true, paused: true, autoplay: false });
  } finally { await browser.close(); }
});

test('profile claim refuses existing browser data and concurrent acquisition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'replication-douyin-profile-'));
  try {
    const claim = await douyin.claimProfile(root);
    await assert.rejects(douyin.claimProfile(root), /已有抖音获取任务/);
    await claim.release();
    const again = await douyin.claimProfile(root);
    await again.release();
    const other = join(root, 'unrelated');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(other);
    await writeFile(join(other, 'existing-browser-data'), 'unchanged');
    await assert.rejects(douyin.claimProfile(other), /已有其他资料/);
    assert.equal(await readFile(join(other, 'existing-browser-data'), 'utf8'), 'unchanged');
  } finally { await rm(root, { recursive: true, force: true }); }
});

function response(bytes, headers = {}, statusCode = 200) {
  return Object.assign(Readable.from([bytes]), { headers, statusCode });
}
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');

test('bounded downloader follows only trusted redirects and publishes complete bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'replication-douyin-download-'));
  try {
    let calls = 0;
    const output = join(root, 'video.mp4');
    await douyin.download(MEDIA, output, {}, async url => {
      assert.match(url.hostname, /douyinvod\.com$/);
      return ++calls === 1 ? response('', { location: '/final' }, 302) : response(mp4, { 'content-type': 'video/mp4' });
    });
    assert.equal(calls, 2);
    assert.deepEqual(await readFile(output), mp4);
    await assert.rejects(douyin.download(MEDIA, output, {}, async () => response(mp4)), /EEXIST/);
    assert.deepEqual(await readFile(output), mp4);
    assert.deepEqual(await readdir(root), ['video.mp4']);
    await assert.rejects(douyin.download(MEDIA, join(root, 'bad.mp4'), {}, async () => response('', { location: 'https://127.0.0.1/private' }, 302)), /媒体域名/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('downloader removes partial files on validation failure and cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'replication-douyin-invalid-'));
  try {
    for (const makeResponse of [() => response('not a video'), () => response(mp4, { 'content-length': 201 * 1024 * 1024 }),
      () => response('<html>verify</html>', { 'content-type': 'text/html' }), () => response('')]) {
      await assert.rejects(douyin.download(MEDIA, join(root, 'bad.mp4'), {}, async () => makeResponse()));
      assert.deepEqual(await readdir(root), []);
    }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(douyin.download(MEDIA, join(root, 'abort.mp4'), { signal: controller.signal }, async () => {
      assert.fail('cancelled download must not send a request');
    }), { name: 'AbortError' });
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed video validation removes the candidate before a valid alternative is published', async () => {
  const root = await mkdtemp(join(tmpdir(), 'replication-douyin-validate-'));
  try {
    const output = join(root, 'video.mp4');
    let validated = 0;
    const options = { validateVideo: async path => {
      validated++;
      assert.notEqual(path, output);
      assert.match(path, /\.part$/);
      const bytes = await readFile(path);
      assert.deepEqual((await readdir(root)).filter(name => name === 'video.mp4'), [], 'formal output must not exist before validation');
      if (bytes.length === mp4.length) throw new Error('合成候选只有文件头，无法解码');
    } };
    await assert.rejects(douyin.download(MEDIA, output, options, async () => response(mp4)), /无法解码/);
    assert.deepEqual(await readdir(root), [], 'failed validation must remove its temporary file');
    const good = Buffer.concat([mp4, Buffer.from('fixture-video-payload')]);
    await douyin.download(`${MEDIA}&alternative=1`, output, options, async () => response(good));
    assert.equal(validated, 2);
    assert.deepEqual(await readFile(output), good);
    assert.deepEqual(await readdir(root), ['video.mp4']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
