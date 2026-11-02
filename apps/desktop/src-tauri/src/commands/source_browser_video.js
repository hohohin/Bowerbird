// Source-document observations only. Native code owns capture authorization and saving.
(() => {
  if (window.__bbSourceVideo) return;
  const fetchResource = window.fetch.bind(window);
  const objectUrls = new Map(), gestures = new Map(), manifests = new Map(), reads = new Map();
  const buffers = new WeakMap(), sourceBuffers = new WeakMap(), appended = new WeakMap();
  const metadata = [], pending = new Set();
  const MAX_TEXT = 1024 * 1024, CHUNK = 64 * 1024;
  const fail = message => { throw new Error(message); };
  const http = raw => {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try { const url = new URL(raw, location.href); return /^https?:$/.test(url.protocol) && !url.username && !url.password && url.href.length <= 8192 ? url.href : null; } catch { return null; }
  };
  const identity = raw => {
    try {
      const url = new URL(raw);
      if (/(^|\.)xiaohongshu\.com$/.test(url.hostname)) return ['xhs', url.pathname.match(/\/(?:explore|discovery\/item)\/([^/]+)/)?.[1]];
      if (/(^|\.)pinterest\.[a-z.]+$/.test(url.hostname)) return ['pin', url.pathname.match(/\/pin\/(\d+)/)?.[1]];
    } catch { /* not a supported detail page */ }
    return [];
  };
  function bounded(map, key, value, maximum = 64) {
    map.set(key, value);
    if (map.size > maximum) map.delete(map.keys().next().value);
  }
  async function text(response) {
    if (Number(response.headers.get('content-length')) > MAX_TEXT || !response.body) return '';
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.byteLength; if (size > MAX_TEXT) return '';
        chunks.push(item.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return new TextDecoder().decode(bytes);
    } finally { await reader.cancel().catch(() => {}); }
  }
  function observe(url, body, documentUrl) {
    if (!body || location.href !== documentUrl) return;
    if (/^\s*#EXTM3U/.test(body) || /^\s*(?:<\?xml[^>]*>\s*)?<MPD[\s>]/i.test(body)) {
      const links = [];
      if (/^\s*#EXTM3U/.test(body)) {
        for (const line of body.split(/\r?\n/)) {
          if (line.trim() && !line.startsWith('#')) links.push(line.trim());
          for (const match of line.matchAll(/\bURI="([^"]+)"/g)) links.push(match[1]);
        }
      } else {
        const xml = new DOMParser().parseFromString(body, 'application/xml');
        for (const element of xml.querySelectorAll('SegmentTemplate,SegmentURL,Initialization')) {
          let base = url;
          const parents = []; for (let node = element; node; node = node.parentElement) parents.unshift(node);
          for (const parent of parents) {
            const bases = [...parent.children].filter(child => child.localName === 'BaseURL');
            if (bases.length === 1) { try { base = new URL(bases[0].textContent.trim(), base).href; } catch {} }
          }
          for (const key of ['media', 'initialization', 'sourceURL']) {
            const value = element.getAttribute(key); if (value) { try { links.push(new URL(value, base).href); } catch {} }
          }
        }
      }
      const patterns = links.slice(0, 2000).map(link => {
        try {
          const absolute = new URL(link, url).href;
          const escaped = absolute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp('^' + escaped.replace(/\\\$[^$]+\\\$/g, '[^/?]+') + '$');
        } catch { return null; }
      }).filter(Boolean);
      bounded(manifests, url, { documentUrl, patterns }, 24);
    } else if (/^\s*[\[{]/.test(body)) {
      try { metadata.push({documentUrl, value:JSON.parse(body)}); if (metadata.length > 12) metadata.shift(); } catch {}
    }
  }
  function watch(response, documentUrl) {
    if (pending.size >= 8) return;
    const mime = response.headers.get('content-type') || '';
    if (!/json|mpegurl|dash\+xml/i.test(mime) && !/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(response.url)) return;
    const work = text(response.clone()).then(body => observe(response.url, body, documentUrl)).catch(() => {});
    pending.add(work); void work.finally(() => pending.delete(work));
  }
  const responseBytes = Response.prototype.arrayBuffer;
  Response.prototype.arrayBuffer = async function(...args) {
    const value = await responseBytes.apply(this, args); buffers.set(value, {url:this.url, documentUrl:location.href}); return value;
  };
  window.fetch = function(...args) {
    const documentUrl = location.href;
    return fetchResource(...args).then(response => { try { watch(response, documentUrl); } catch {} return response; });
  };
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(...args) {
    const documentUrl = location.href;
    this.addEventListener('load', () => {
      try {
        if (this.responseType === 'arraybuffer' && this.response) buffers.set(this.response, {url:this.responseURL, documentUrl});
        if ((!this.responseType || this.responseType === 'text') && this.responseText.length <= MAX_TEXT) observe(this.responseURL, this.responseText, documentUrl);
        if (this.responseType === 'json') {
          const length = this.getResponseHeader('content-length');
          if (length && /^\d+$/.test(length) && Number(length) <= MAX_TEXT && !this.getResponseHeader('content-encoding')) {
            metadata.push({documentUrl, value:this.response}); if (metadata.length > 12) metadata.shift();
          }
        }
      } catch {}
    }, {once:true});
    return xhrOpen.apply(this, args);
  };
  const createUrl = URL.createObjectURL;
  URL.createObjectURL = function(object) {
    const url = createUrl.call(this, object);
    bounded(objectUrls, url, {object, documentUrl:location.href}); return url;
  };
  const revokeUrl = URL.revokeObjectURL;
  URL.revokeObjectURL = function(url) { objectUrls.delete(url); return revokeUrl.call(this, url); };
  if (window.MediaSource && window.SourceBuffer) {
    const add = MediaSource.prototype.addSourceBuffer, append = SourceBuffer.prototype.appendBuffer;
    MediaSource.prototype.addSourceBuffer = function(...args) { const buffer = add.apply(this, args); sourceBuffers.set(buffer, this); return buffer; };
    SourceBuffer.prototype.appendBuffer = function(value) {
      const result = append.call(this, value);
      const observed = buffers.get(value) || buffers.get(value?.buffer), source = sourceBuffers.get(this);
      if (observed && source) { const values = appended.get(source) || []; if (values.length < 200) values.push(observed); appended.set(source, values); }
      return result;
    };
  }
  function sources(video) { return [video.currentSrc, video.src, ...[...video.querySelectorAll('source[src]')].map(node => node.src)]; }
  function remember(video, source, pageUrl) {
    if (video instanceof HTMLVideoElement && sources(video).includes(source)) bounded(gestures, source, {video, pageUrl, documentUrl:location.href}, 8);
  }
  function current(source, pageUrl) {
    const gesture = gestures.get(source);
    if (!gesture || gesture.documentUrl !== location.href || gesture.pageUrl !== pageUrl || !gesture.video.isConnected || !sources(gesture.video).includes(source)) fail('来源页面或视频已切换，请重新拖入。');
    if (gesture.video.mediaKeys) fail('此视频受播放保护，无法采集。');
    return gesture;
  }
  function records(value, kind, id) {
    const result = []; const seen = new WeakSet(); let remaining = 3000;
    function visit(node, depth) {
      if (!node || typeof node !== 'object' || seen.has(node) || depth > 12 || remaining-- <= 0) return;
      seen.add(node);
      const same = String(kind === 'xhs' ? node.noteId || node.note_id || node.id || '' : node.id || '') === id;
      if (same && (kind === 'xhs' ? node.video : node.videos || node.story_pin_data)) result.push(node);
      for (const [key, child] of Object.entries(node).slice(0, 300)) {
        if (key === id && child && typeof child === 'object') {
          const item = child.note || child;
          if (kind === 'xhs' ? item.video : item.videos || item.story_pin_data) result.push(item);
        }
        visit(child, depth + 1);
      }
    }
    visit(value, 0); return [...new Set(result)];
  }
  function videoUrls(record, kind, video) {
    if (record.is_drm || record.drm || record.video?.is_drm || record.video?.drm_type) fail('此视频受播放保护，无法采集。');
    if (kind === 'xhs') {
      const stream = record.video?.media?.stream || {};
      const variants = ['h264','h265','av1'].flatMap(key => Array.isArray(stream[key]) ? stream[key] : []);
      return [...variants.map(item => item.masterUrl || item.master_url || item.url), record.video?.url, record.video?.playUrl].map(http).filter(Boolean).slice(0, 1);
    }
    const groups = [];
    if (record.videos?.video_list) groups.push(record.videos);
    for (const page of record.story_pin_data?.pages || []) for (const block of page.blocks || []) if (block.video?.video_list) groups.push(block.video);
    const matching = groups.filter(group => Object.values(group.video_list).some(item => item.thumbnail === video.poster || item.url && sources(video).includes(item.url)));
    const chosen = matching.length === 1 ? matching : groups;
    if (chosen.length > 1) fail('此笔记包含多个视频，暂时无法确认本次拖动的视频。');
    const variants = Object.values(chosen[0]?.video_list || {}).filter(item => http(item.url));
    variants.sort((a,b) => Number(/\.mp4(?:[?#]|$)/i.test(b.url)) - Number(/\.mp4(?:[?#]|$)/i.test(a.url)) || (b.width || 0)*(b.height || 0) - (a.width || 0)*(a.height || 0));
    return variants.slice(0,1).map(item => http(item.url));
  }
  async function resolve(source, pageUrl) {
    if (http(source)) return source;
    const gesture = current(source, pageUrl);
    if (!source.startsWith('blob:')) fail('当前视频来源暂不支持采集。');
    const object = objectUrls.get(source)?.object;
    if (object instanceof Blob) return source;
    await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => setTimeout(resolve, 1000))]);
    current(source, pageUrl);
    const [kind,id] = identity(pageUrl);
    if (id) {
      const states = [window.__INITIAL_STATE__, window.__PWS_DATA__, window.__PWS_INITIAL_PROPS__];
      for (const node of document.querySelectorAll('script#__PWS_DATA__,script#__NEXT_DATA__')) {
        if (node.textContent.length <= MAX_TEXT) { try { states.push(JSON.parse(node.textContent)); } catch {} }
      }
      states.push(...metadata.filter(item => item.documentUrl === location.href).map(item => item.value));
      const urls = [...new Set(states.flatMap(state => records(state,kind,id)).flatMap(record => videoUrls(record,kind,gesture.video)))];
      if (urls.length === 1) return urls[0];
      if (urls.length > 1) fail('网页提供了多个视频来源，暂时无法确认本次拖动的视频。');
    }
    const segments = appended.get(object) || [];
    const matches = [...manifests].filter(([,entry]) => entry.documentUrl === location.href && segments.some(segment => segment.documentUrl === location.href && entry.patterns.some(pattern => pattern.test(segment.url))));
    if (matches.length === 1) return matches[0][0];
    if (matches.length > 1) fail('检测到多个分段清单，暂时无法确认本次拖动的视频。');
    if (object && !(object instanceof Blob)) fail('尚未找到当前视频的分段清单，请播放视频后重新拖入。');
    return source; // A pre-existing ordinary Blob can still be read in its creating document.
  }
  async function close(id) {
    const state = reads.get(id); if (!state) return;
    reads.delete(id); clearTimeout(state.timer); state.abort.abort(); await state.reader?.cancel().catch(() => {});
  }
  async function manifestBase(url, requestId) {
    if (!http(url) || reads.size >= 4) return {type:'unknown'};
    const abort = new AbortController();
    reads.set(requestId, {abort, reader:null, timer:setTimeout(() => { void close(requestId); },15000)});
    try {
      // no-cors + manual is forbidden by Fetch. A CORS/CSP failure cannot
      // establish the manifest base, so native code must reject that result.
      const response = await fetchResource(url, {mode:'cors',redirect:'manual',credentials:'include',signal:abort.signal});
      return {type:response.type,ok:response.ok};
    } catch { return {type:'unknown'}; }
    finally { await close(requestId); }
  }
  async function open(url, maximum, requestId = crypto.randomUUID()) {
    if (reads.size >= 4 || !Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 200*1024*1024) fail('视频读取任务过多或大小限制无效。');
    if (!url.startsWith('blob:') && !http(url)) fail('视频地址无效。');
    const abort = new AbortController(); const timeout = setTimeout(() => { void close(requestId); }, 120000);
    const state = {reader:null, abort, maximum, received:0, rest:null, total:null, timer:timeout};
    reads.set(requestId,state);
    try {
      const response = await fetchResource(url, {credentials:'include', signal:abort.signal}).catch(error => {
        if (error?.name === 'TypeError') fail('当前页面无法读取该网络资源。');
        throw error;
      });
      if (!response.ok || response.status === 206) fail('网站未返回完整视频内容，请重新拖入。');
      const rawLength = response.headers.get('content-length');
      const encoding = response.headers.get('content-encoding');
      const total = rawLength === null || encoding && encoding.toLowerCase() !== 'identity' ? null : Number(rawLength);
      if (total !== null && (!Number.isSafeInteger(total) || total < 0 || total > maximum)) fail('视频超过大小限制。');
      if (!response.body) fail('浏览器没有返回视频内容。');
      if (!reads.has(requestId)) fail('视频读取已结束，请重新拖入。');
      state.reader = response.body.getReader(); state.total = total;
      return {id:requestId, url:response.url || url, contentType:response.headers.get('content-type') || '', totalBytes:total};
    } catch (error) { await close(requestId); throw error; }
  }
  async function read(id) {
    const state = reads.get(id); if (!state) fail('视频读取已结束，请重新拖入。');
    try {
      const item = state.rest ? {value:state.rest,done:false} : await state.reader.read();
      if (item.done) {
        if (state.total !== null && state.received !== state.total) fail('网站未返回完整视频内容。');
        await close(id); return {data:'',eof:true};
      }
      const bytes = item.value.subarray(0,CHUNK); state.rest = item.value.length > CHUNK ? item.value.subarray(CHUNK) : null;
      state.received += bytes.length;
      if (state.received > state.maximum) fail('视频超过大小限制。');
      return {data:btoa(String.fromCharCode(...bytes)),eof:false};
    } catch (error) { await close(id); throw error; }
  }
  window.__bbSourceVideo = Object.freeze({remember, resolve, open, read, close, manifestBase});
  window.addEventListener('pagehide', () => { for (const id of reads.keys()) void close(id); });
})();
