// Observe the target work's normal playback metadata; never synthesize platform signatures.
(() => {
  if (window.top !== window || window.__bbDouyinObserver) return;
  window.__bbDouyinObserver = true;
  const initialId = __EXPECTED_ID__;
  let sent = false;
  const identity = () => initialId || location.pathname.match(/\/(?:share\/)?video\/(\d{12,24})/)?.[1] || new URL(location.href).searchParams.get('modal_id');
  const send = detail => {
    const id = identity();
    if (sent || !id || String(detail?.aweme_id) !== id) return;
    const video = detail.video || {};
    const blocked = detail.images?.length || detail.image_post_info ? 'image' : video.drm_type || video.is_drm ? 'protected' : null;
    const urls = [...new Set(['play_addr_h264', 'play_addr', 'download_addr'].flatMap(key => video[key]?.url_list || []))].filter(url => typeof url === 'string' && url.length < 8192).slice(0,6);
    if (!blocked && !urls.length) return;
    const value = { videoId:id, name:String(detail.desc || '抖音参考视频').slice(0,160), duration:Number(video.duration || detail.duration || 0)/1000, blocked, urls, userAgent:navigator.userAgent.slice(0,512) };
    sent = true;
    // WebView2 can block custom-scheme navigation without a user gesture on
    // remote pages. The native poll reads this same bounded result as well.
    window.__bbDouyinResult = value;
    location.href = 'bb-replication-capture://result/?payload=' + encodeURIComponent(JSON.stringify(value));
  };
  function inspect(value) {
    const seen = new WeakSet(); let remaining = 5000;
    function visit(value, depth) {
      if (!value || typeof value !== 'object' || depth > 12 || seen.has(value) || remaining-- <= 0) return;
      seen.add(value);
      if (value.aweme_id !== undefined && value.video) send(value);
      for (const item of Object.values(value).slice(0,150)) visit(item, depth+1);
    }
    visit(value,0);
  }
  window.__bbDouyinInspect = inspect;
  const relevant = url => {
    try { const parsed = new URL(url, location.href); return ['www.douyin.com','www.iesdouyin.com'].includes(parsed.hostname) && parsed.pathname === '/aweme/v1/web/aweme/detail/'; } catch { return false; }
  };
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this,args);
    if (relevant(response.url)) {
      const copy = response.clone();
      void copy.text().then(text => { if(text.length < 2*1024*1024) inspect(JSON.parse(text)); }).catch(()=>{});
    }
    return response;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(...args) {
    if (relevant(String(args[1]))) this.addEventListener('load', () => {
      try { if (this.responseType === 'json') inspect(this.response); else if ((!this.responseType || this.responseType === 'text') && this.responseText.length < 2*1024*1024) inspect(JSON.parse(this.responseText)); } catch {}
    }, {once:true});
    return originalOpen.apply(this,args);
  };
  // Share pages may render their own item info without a later detail request.
  const scan = () => {
    if (sent) return;
    for (const key of ['_ROUTER_DATA','__INITIAL_STATE__','__NEXT_DATA__']) { try { inspect(window[key]); } catch {} }
    const text = document.getElementById('RENDER_DATA')?.textContent;
    if (text && text.length < 2*1024*1024) { try { inspect(JSON.parse(decodeURIComponent(text))); } catch {} }
  };
  const timer = setInterval(() => { scan(); if(sent) clearInterval(timer); }, 750);
})();
