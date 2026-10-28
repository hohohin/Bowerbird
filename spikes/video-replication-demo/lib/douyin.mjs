// Standalone adaptation of apps/desktop/src-tauri/src/commands/video_replication/
// douyin.rs, douyin_browser.rs and douyin_media.rs. Vendor scripts are unchanged.
import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { isIP } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, readdir, open, unlink, access, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const PAGE_HOSTS = ['douyin.com', 'www.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'];
const MEDIA_HOSTS = ['douyinvod.com', 'douyin.com', 'amemv.com', 'snssdk.com', 'bytecdn.cn', 'bytecdn.com'];
const MAX_BYTES = 200 * 1024 * 1024;
const PROFILE_MARKER = '.replication-demo-profile';
const domain = (host, roots) => roots.some(root => host === root || host.endsWith(`.${root}`));
const secure = url => url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443');

function videoId(url) {
  if (!PAGE_HOSTS.includes(url.hostname)) return null;
  const path = url.pathname.replace(/\/$/, '');
  const id = path.match(/^\/(?:share\/)?video\/(\d{12,24})$/)?.[1]
    || (!path ? url.searchParams.get('modal_id') : null);
  return /^\d{12,24}$/.test(id || '') ? id : null;
}

function parseShareUrl(input) {
  if (typeof input !== 'string' || !input.trim() || [...input].length > 8000) {
    throw new Error('请粘贴抖音分享文案，最多 8000 字');
  }
  const found = new Set();
  for (const token of input.split(/[\s<>\[\]（）()"'“”‘’]+/)) {
    const start = token.indexOf('https://');
    if (start < 0) continue;
    const raw = token.slice(start).replace(/[.,，。！!；;：:、?？]+$/, '');
    let url;
    try { url = new URL(raw); } catch { continue; }
    if (!secure(url) || !PAGE_HOSTS.includes(url.hostname)) continue;
    const id = videoId(url);
    if (id) found.add(`https://www.douyin.com/video/${id}`);
    else if (url.hostname === 'v.douyin.com' && /^\/[\w-]{3,100}\/?$/.test(url.pathname)) {
      found.add(`https://v.douyin.com/${url.pathname.replace(/^\/|\/$/g, '')}/`);
    }
  }
  if (found.size !== 1) throw new Error('请提供一个 HTTPS 抖音视频链接，支持完整分享文案、分享短链或作品链接');
  return [...found][0];
}

function mediaUrl(raw) {
  let url;
  try { url = new URL(raw.startsWith('//') ? `https:${raw}` : raw); } catch { throw new Error('视频地址无效'); }
  if (raw.length > 8192 || !secure(url) || !domain(url.hostname, MEDIA_HOSTS)) {
    throw new Error('视频地址不在支持的抖音媒体域名中');
  }
  return url;
}

function publicIp(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
      || (a === 198 && [18, 19].includes(b)) || (a === 192 && b === 0 && [0, 2].includes(c))
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6) return false;
  // IPv4-mapped IPv6 is normalized by URL, including dotted input.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const words = normalized.slice(7).split(':').map(word => parseInt(word, 16));
    return words.length === 2 && publicIp(`${words[0] >> 8}.${words[0] & 255}.${words[1] >> 8}.${words[1] & 255}`);
  }
  const [a, b = '0'] = normalized.split(':');
  const first = parseInt(a, 16), second = parseInt(b || '0', 16);
  return (first & 0xe000) === 0x2000 && !(first === 0x2001 && (second === 0xdb8 || second < 0x200));
}

function selected(value, expected) {
  if (!expected || value?.videoId !== expected) throw new Error('未取得目标作品的视频');
  if (value.blocked === 'image') throw new Error('此链接为图文作品，请选择视频');
  if (value.blocked === 'protected') throw new Error('此视频受播放保护，无法获取');
  if (value.blocked === 'live') throw new Error('直播链接暂不支持，请选择已发布的视频作品');
  if (!Number.isFinite(value.duration) || value.duration < 0 || value.duration > 120) {
    throw new Error('参考视频最多 120 秒，请截取后上传');
  }
  const urls = Array.isArray(value.urls) ? value.urls.filter(raw => {
    try { return typeof raw === 'string' && !!mediaUrl(raw); } catch { return false; }
  }) : [];
  if (!urls.length || value.urls.length > 6) throw new Error('未取得可用的抖音播放地址');
  return { ...value, urls };
}

async function loadChromium() {
  const require = createRequire(import.meta.url);
  try { return (await import(pathToFileURL(require.resolve('playwright')).href)).chromium; } catch {}
  try { return (await import('../../../apps/html-renderer/node_modules/playwright/index.mjs')).chromium; } catch {}
  throw new Error('缺少浏览器依赖，请在 Demo 目录执行 npm install');
}

async function claimProfile(profileDir) {
  if (!profileDir) throw new Error('请为 Demo 指定独立的浏览器资料目录');
  const profile = resolve(profileDir);
  await mkdir(profile, { recursive: true });
  const entries = await readdir(profile);
  if (entries.length && !entries.includes(PROFILE_MARKER)) {
    throw new Error('该浏览器目录已有其他资料，请为 Demo 选择一个空目录');
  }
  const marker = await open(join(profile, PROFILE_MARKER), 'a');
  await marker.close();
  const lockPath = join(profile, '.replication-demo-acquiring');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) { throw new Error('已有抖音获取任务使用该目录，请等待完成；若上次异常退出，请清除 Demo 目录中的获取锁', { cause: error }); }
  return { profile, release: async () => { await lock.close(); await unlink(lockPath).catch(() => {}); } };
}

async function responseFor(url, { cookies, userAgent, referer, signal }) {
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicIp(item.address))) throw new Error('媒体地址未指向公网服务');
  const cookie = (await cookies(url.href)).map(item => `${item.name}=${item.value}`).join('; ');
  return new Promise((resolveResponse, reject) => {
    // No proxy and no second DNS lookup: connect only to a vetted public address.
    const request = get(url, {
      agent: false, signal,
      lookup: (_host, options, callback) => options.all
        ? callback(null, addresses)
        : callback(null, addresses[0].address, addresses[0].family),
      headers: { Referer: referer, 'User-Agent': userAgent, ...(cookie ? { Cookie: cookie } : {}) },
    }, resolveResponse);
    request.on('error', reject);
  });
}

async function download(raw, outputPath, options, requestResponse = responseFor) {
  let url = mediaUrl(raw);
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(120000)]);
  const temporary = `${outputPath}.${randomUUID()}.part`;
  let file, activeResponse;
  try {
    for (let redirect = 0; redirect < 6; redirect++) {
      signal.throwIfAborted();
      const response = activeResponse = await requestResponse(url, { ...options, signal });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        if (!response.headers.location) throw new Error('视频重定向无效');
        url = mediaUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        throw new Error('抖音未允许下载此视频，请在独立窗口登录验证后重试');
      }
      if (Number(response.headers['content-length'] || 0) > MAX_BYTES
        || /(?:text\/|json)/i.test(response.headers['content-type'] || '')) {
        response.destroy();
        throw new Error('视频超过 200 MiB 或返回了验证页面');
      }
      file = await open(temporary, 'wx');
      let size = 0, header = Buffer.alloc(0);
      for await (const chunk of response) {
        signal.throwIfAborted();
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('参考视频超过 200 MiB');
        if (header.length < 12) header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)]);
        let written = 0;
        while (written < chunk.length) written += (await file.write(chunk, written)).bytesWritten;
      }
      if (size < 12 || header.toString('ascii', 4, 8) !== 'ftyp') throw new Error('抖音未返回有效 MP4 视频，请完成页面验证后重试');
      await file.sync();
      await file.close();
      file = null;
      await options.validateVideo?.(temporary);
      signal.throwIfAborted();
      // The task/profile locks serialize acquisition; publish only a validated complete file.
      try {
        await access(outputPath);
        const error = new Error('EEXIST: 视频目标文件已存在，请使用新的保存路径');
        error.code = 'EEXIST';
        throw error;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(temporary, outputPath);
      return;
    }
    throw new Error('视频重定向次数过多');
  } finally {
    activeResponse?.destroy();
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

/** Opens only the demo-owned Chromium profile; validateVideo runs before accepting each candidate. */
export async function fetchDouyinVideo({ input, outputPath, profileDir, onProgress = () => {}, signal, browserExecutable, validateVideo }) {
  const sourceUrl = parseShareUrl(input);
  if (!outputPath) throw new Error('未指定视频保存路径');
  signal?.throwIfAborted();
  const targetPath = resolve(outputPath);
  await mkdir(dirname(targetPath), { recursive: true });
  const chromium = await loadChromium();
  const claim = await claimProfile(profileDir);
  let context, page, expected = videoId(new URL(sourceUrl)), pendingResponses = 0;
  const abort = () => { void context?.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    onProgress('正在打开 Demo 独立抖音窗口；若页面要求登录或验证，请在该窗口完成');
    const options = { headless: false, viewport: { width: 1100, height: 800 }, acceptDownloads: false,
      args: ['--mute-audio', '--disable-background-networking'],
      ...(browserExecutable ? { executablePath: browserExecutable } : { channel: 'chrome' }) };
    try { context = await chromium.launchPersistentContext(claim.profile, options); }
    catch (error) {
      if (browserExecutable) throw new Error('无法启动指定浏览器，请检查 Demo 的浏览器程序路径', { cause: error });
      try { context = await chromium.launchPersistentContext(claim.profile, { ...options, channel: 'msedge' }); }
      catch { throw new Error('未找到可用 Chrome 或 Edge，请安装浏览器或配置 BROWSER_EXECUTABLE', { cause: error }); }
    }
    signal?.throwIfAborted();
    const [capture, quiet] = await Promise.all([
      readFile(new URL('./vendor/douyin_capture.js', import.meta.url), 'utf8'),
      readFile(new URL('./vendor/douyin_quiet.js', import.meta.url), 'utf8'),
    ]);
    await context.addInitScript(quiet);
    await context.addInitScript(capture.replace('__EXPECTED_ID__', JSON.stringify(expected)));
    page = context.pages()[0] || await context.newPage();
    for (const extra of context.pages().filter(item => item !== page)) await extra.close();
    context.on('page', extra => { if (extra !== page) void extra.close().catch(() => {}); });
    await context.route('**/*', async route => {
      const request = route.request();
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return route.continue();
      let url;
      try { url = new URL(request.url()); } catch { return route.abort(); }
      const id = videoId(url);
      if (!secure(url) || !domain(url.hostname, ['douyin.com', 'iesdouyin.com'])
        || (id && expected && id !== expected)) return route.abort();
      if (id && !expected) expected = id;
      return route.continue();
    });
    page.on('response', async response => {
      const url = new URL(response.url());
      if (!['www.douyin.com', 'www.iesdouyin.com'].includes(url.hostname)
        || url.pathname !== '/aweme/v1/web/aweme/detail/' || pendingResponses >= 20) return;
      pendingResponses++;
      try {
        if (Number(response.headers()['content-length'] || 0) > 2 * 1024 * 1024) return;
        const bytes = await response.body();
        if (bytes.length < 2 * 1024 * 1024) {
          const value = JSON.parse(bytes.toString('utf8'));
          await page.evaluate(payload => window.__bbDouyinInspect?.(payload), value);
        }
      } catch {} finally { pendingResponses--; }
    });
    // The observer may cancel navigation after capturing; polling below still reads its result.
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const deadline = Date.now() + 600000;
    let value, reminded = false;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (page.isClosed()) throw new Error('抖音获取窗口已关闭，请重新获取');
      const url = new URL(page.url());
      if (/\/(?:live|webcast)(?:\/|$)/.test(url.pathname) || url.hostname === 'live.douyin.com') {
        throw new Error('直播链接暂不支持，请选择已发布的视频作品');
      }
      expected ||= videoId(url);
      value = await page.evaluate(() => window.__bbDouyinResult || null).catch(() => null);
      if (value && value.videoId === expected) break;
      if (!reminded && deadline - Date.now() < 555000) {
        onProgress('尚未读取到目标视频；请查看独立抖音窗口，按页面提示完成登录或验证');
        reminded = true;
        await page.bringToFront().catch(() => {});
      }
      await delay(500, undefined, { signal });
    }
    if (!value) throw new Error('等待目标视频超时，请完成独立窗口验证后重新获取');
    const candidate = selected(value, expected);
    const canonical = `https://www.douyin.com/video/${expected}`;
    onProgress('已识别目标作品，正在下载视频');
    let lastError;
    for (const raw of candidate.urls) {
      signal?.throwIfAborted();
      try {
        await download(raw, targetPath, { cookies: url => context.cookies(url), referer: canonical,
          userAgent: candidate.userAgent || await page.evaluate(() => navigator.userAgent), signal, validateVideo });
        onProgress('抖音视频已下载，正在准备媒体校验');
        return { path: targetPath, title: String(candidate.name || '抖音参考视频').slice(0, 160), sourceUrl: canonical, videoId: expected };
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
      }
    }
    throw new Error('无法下载目标视频，请在独立窗口完成验证后重试，或上传本地视频', { cause: lastError });
  } finally {
    signal?.removeEventListener('abort', abort);
    await context?.close().catch(() => {});
    await claim.release();
  }
}

export const __test = { parseShareUrl, videoId, mediaUrl, publicIp, selected, claimProfile, loadChromium, download };
