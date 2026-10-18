// This browser acquires reference files; it is never a video player.
(() => {
  const media = HTMLMediaElement.prototype;
  const pause = media.pause;
  const stop = element => {
    element.muted = true;
    if (element.hasAttribute('autoplay')) element.removeAttribute('autoplay');
    pause.call(element);
  };
  Object.defineProperty(media, 'play', {
    configurable: false, writable: false,
    value() { stop(this); return Promise.reject(new DOMException('Playback disabled in reference acquisition', 'NotAllowedError')); },
  });
  // Declarative autoplay bypasses play(); stop new media before it can run.
  const scan = root => {
    if (root instanceof HTMLMediaElement) stop(root);
    root.querySelectorAll?.('video,audio').forEach(stop);
  };
  document.addEventListener('play', event => { if (event.target instanceof HTMLMediaElement) stop(event.target); }, true);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') scan(record.target);
      else record.addedNodes.forEach(scan);
    }
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['autoplay'] });
  scan(document);
})();
