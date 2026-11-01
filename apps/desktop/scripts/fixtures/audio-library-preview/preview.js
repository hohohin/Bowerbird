import { formatTime } from './waveform.js';

const scroll = document.querySelector('.audio-scroll');
const grid = document.querySelector('.audio-grid');
const media = new Audio();
media.preload = 'none';
media.hidden = true;
document.body.append(media);
const peakCache = new Map();
const cards = new Map();
const ROW_HEIGHT = 244, GAP = 28, CACHE_LIMIT = 32;
let items = [], columns = 3, cardWidth = 0, active = null, generation = 0, progressFrame = 0;

function localUrl(value) {
  const url = new URL(value, location.href);
  if (url.origin !== location.origin) throw new Error('Fixture URLs must be same-origin');
  return url.href;
}

function parseManifest(value) {
  if (!Array.isArray(value) || !value.length) throw new Error('Empty audio manifest');
  return value.map(item => {
    if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.url !== 'string' || !item.url ||
      typeof item.peaksUrl !== 'string' || !item.peaksUrl || !Number.isFinite(item.duration) || item.duration <= 0) throw new Error('Invalid audio manifest');
    return { ...item, url: localUrl(item.url), peaksUrl: localUrl(item.peaksUrl) };
  });
}

async function loadPeaks(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Waveform unavailable');
  const data = await response.json();
  if (!Array.isArray(data.peaks) || !data.peaks.length || data.peaks.length > 16384 ||
    data.peaks.some(pair => !Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isFinite) || pair[0] < -1 || pair[1] > 1 || pair[0] > pair[1])) throw new Error('Invalid waveform');
  const framesPerPeak = data.framesPerPeak || 1;
  const totalFrames = data.totalFrames || data.peaks.length;
  if (!Number.isFinite(framesPerPeak) || framesPerPeak <= 0 || !Number.isFinite(totalFrames) || totalFrames <= 0 ||
    Math.ceil(totalFrames / framesPerPeak) !== data.peaks.length) throw new Error('Invalid waveform timing');
  const maximum = data.peaks.reduce((value, pair) => Math.max(value, Math.abs(pair[0]), Math.abs(pair[1])), 0);
  // Relative amplitude for this file only; this is never applied to media.volume.
  return { peaks: data.peaks, framesPerPeak, totalFrames, displayGain: maximum > 0 ? .8 / maximum : 1 };
}

function cachedPeaks(url) {
  let result = peakCache.get(url);
  if (result) peakCache.delete(url);
  else result = loadPeaks(url).catch(error => { peakCache.delete(url); throw error; });
  peakCache.set(url, result);
  if (peakCache.size > CACHE_LIMIT) peakCache.delete(peakCache.keys().next().value);
  return result;
}

function paintWave(card, data) {
  if (!card.node.isConnected) return;
  const width = card.wave.clientWidth, height = card.wave.clientHeight;
  const scale = Math.min(devicePixelRatio || 1, 2);
  card.canvas.width = Math.round(width * scale); card.canvas.height = Math.round(height * scale);
  const context = card.canvas.getContext('2d');
  context.scale(scale, scale);
  context.strokeStyle = getComputedStyle(card.node).getPropertyValue('--bb-muted').trim();
  context.lineWidth = 1;
  context.beginPath();
  // Aggregate extrema covering each display column. Never average away transients;
  // frame-based coverage preserves the shorter final Rust peak bucket.
  for (let x = 0; x < width; x += 2) {
    const from = Math.floor(x / width * data.totalFrames / data.framesPerPeak);
    const to = Math.min(data.peaks.length, Math.ceil((x + 2) / width * data.totalFrames / data.framesPerPeak));
    let low = 0, high = 0;
    for (let index = from; index < to; index++) { low = Math.min(low, data.peaks[index][0]); high = Math.max(high, data.peaks[index][1]); }
    const top = height / 2 - high * data.displayGain * (height - 48) / 2;
    const bottom = height / 2 - low * data.displayGain * (height - 48) / 2;
    context.moveTo(x + .5, Math.min(top, height / 2 - .5)); context.lineTo(x + .5, Math.max(bottom, height / 2 + .5));
  }
  context.stroke();
  card.node.dataset.waveReady = 'true';
}

function drawCard(card) {
  cachedPeaks(card.item.peaksUrl).then(data => paintWave(card, data)).catch(() => {
    if (card.node.isConnected) card.action.textContent = '波形暂不可用';
  });
}

function stop() {
  generation++;
  cancelAnimationFrame(progressFrame); progressFrame = 0;
  media.pause();
  if (media.hasAttribute('src')) { media.removeAttribute('src'); media.load(); }
  if (active) setPlaying(active, false);
  active = null;
}

function setPlaying(card, playing) {
  card.node.dataset.playing = String(playing);
  card.playButton.setAttribute('aria-pressed', String(playing));
  const action = playing ? '暂停' : '从头播放';
  card.playButton.setAttribute('aria-label', `${action} ${card.item.name}`);
  card.playButton.title = action;
}

function animateProgress() {
  if (!active || media.paused) return;
  if (!active.node.isConnected || document.hidden) { stop(); return; }
  const ratio = media.currentTime / (Number.isFinite(media.duration) ? media.duration : active.item.duration);
  active.cursor.style.transform = `translateX(${Math.min(1, ratio) * active.wave.clientWidth}px)`;
  progressFrame = requestAnimationFrame(animateProgress);
}

function play(card, ratio) {
  if (active === card && media.hasAttribute('src')) {
    // Seeking within the loaded file keeps its decoder and buffered data.
    generation++;
    cancelAnimationFrame(progressFrame); progressFrame = 0;
  } else {
    stop();
    active = card;
    // Isolated Tauri harness maps synthetic IDs to their original fixture files.
    const nativePath = window.__BOWERBIRD_AUDIO_NATIVE_SOURCES__?.[card.item.id];
    media.src = nativePath && window.__TAURI_INTERNALS__?.convertFileSrc
      ? window.__TAURI_INTERNALS__.convertFileSrc(nativePath) : card.item.url;
  }
  card.node.dataset.blocked = 'false'; card.action.textContent = '';
  const request = generation;
  // Both controls call synchronously from a real click/keyboard activation.
  media.currentTime = Math.min(Math.max(0, card.item.duration - .01), Math.max(0, ratio) * card.item.duration);
  media.play().then(() => {
    if (request !== generation || active !== card) return;
    setPlaying(card, true);
    animateProgress();
  }).catch(error => {
    if (request !== generation || active !== card) return;
    stop();
    card.node.dataset.blocked = 'true';
    card.action.textContent = error.name === 'NotAllowedError' ? '播放' : '暂时无法播放';
  });
}

function pointerRatio(card, event) {
  const rect = card.wave.getBoundingClientRect();
  return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
}

function showPointer(card, ratio) {
  card.ratio = ratio;
  card.hoverCursor.style.left = `${ratio * 100}%`;
  card.position.textContent = formatTime(ratio * card.item.duration);
}

function bindCard(card) {
  const previewPointer = event => {
    if (event.pointerType !== 'touch') showPointer(card, pointerRatio(card, event));
  };
  card.wave.addEventListener('pointerenter', previewPointer);
  card.wave.addEventListener('pointermove', previewPointer);
  card.wave.addEventListener('click', event => {
    const ratio = event.detail === 0 ? card.ratio : pointerRatio(card, event);
    showPointer(card, ratio);
    play(card, ratio);
  });
  card.playButton.addEventListener('click', event => {
    event.stopPropagation();
    if (active === card && !media.paused) stop(); else play(card, 0);
  });
  card.preview.addEventListener('pointerleave', () => { if (active === card) stop(); });
  card.preview.addEventListener('focusout', event => {
    if (active === card && !card.preview.contains(event.relatedTarget)) stop();
  });
  card.wave.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    showPointer(card, event.key === 'Home' ? 0 : event.key === 'End' ? 1 : Math.min(1, Math.max(0, card.ratio + (event.key === 'ArrowRight' ? .05 : -.05))));
  });
}

function createCard(item, index) {
  const node = document.createElement('article');
  node.className = 'audio-card'; node.dataset.index = String(index); node.setAttribute('role', 'listitem');
  node.innerHTML = '<div class="audio-preview"><button class="audio-wave" type="button"><canvas aria-hidden="true"></canvas><span class="wave-cursor" aria-hidden="true"></span><span class="wave-hover-cursor" aria-hidden="true"></span><span class="wave-position" aria-hidden="true">0:00</span></button><button class="audio-play" type="button" aria-pressed="false"><svg class="play-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 1 8 5-8 5z"/></svg><svg class="pause-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1h3v10H2zm5 0h3v10H7z"/></svg></button><span class="wave-action-label" role="status"></span></div><div class="audio-meta"><span class="audio-name"></span><span class="audio-duration"></span></div>';
  const wave = node.querySelector('.audio-wave'); wave.setAttribute('aria-label', `试听 ${item.name}`);
  node.querySelector('.audio-name').textContent = item.name; node.querySelector('.audio-name').title = item.name;
  node.querySelector('.audio-duration').textContent = formatTime(item.duration);
  const card = { item, node, wave, ratio: 0, preview: node.querySelector('.audio-preview'), playButton: node.querySelector('.audio-play'), canvas: node.querySelector('canvas'), cursor: node.querySelector('.wave-cursor'), hoverCursor: node.querySelector('.wave-hover-cursor'), position: node.querySelector('.wave-position'), action: node.querySelector('.wave-action-label') };
  setPlaying(card, false);
  bindCard(card);
  return card;
}

function renderRange() {
  const top = Math.max(0, scroll.scrollTop - grid.offsetTop + scroll.offsetTop);
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - 1) * columns;
  const end = Math.min(items.length, (Math.ceil((top + scroll.clientHeight) / ROW_HEIGHT) + 1) * columns);
  for (const [index, card] of cards) {
    if (index < first || index >= end) { if (active === card) stop(); card.node.remove(); cards.delete(index); }
  }
  for (let index = first; index < end; index++) {
    let card = cards.get(index);
    if (!card) { card = createCard(items[index], index); cards.set(index, card); grid.append(card.node); drawCard(card); }
    card.node.style.width = `${cardWidth}px`;
    card.node.style.left = `${index % columns * (cardWidth + GAP)}px`;
    card.node.style.top = `${Math.floor(index / columns) * ROW_HEIGHT}px`;
  }
}

function layout() {
  const width = grid.clientWidth;
  columns = Math.max(1, Math.min(3, Math.floor((width + GAP) / (280 + GAP))));
  cardWidth = (width - GAP * (columns - 1)) / columns;
  grid.style.height = `${Math.ceil(items.length / columns) * ROW_HEIGHT - GAP}px`;
  renderRange();
  cards.forEach(drawCard);
}

media.addEventListener('ended', stop);
scroll.addEventListener('scroll', () => { stop(); renderRange(); }, { passive: true });
window.addEventListener('blur', stop);
window.addEventListener('pagehide', stop);
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') stop(); });
new MutationObserver(() => { if (active && !active.node.isConnected) stop(); }).observe(grid, { childList: true });
new ResizeObserver(layout).observe(grid);
document.querySelector('.theme-toggle').addEventListener('click', event => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  const label = theme === 'dark' ? '切换为浅色' : '切换为深色';
  event.currentTarget.setAttribute('aria-label', label); event.currentTarget.title = label;
  cards.forEach(drawCard);
});

try {
  const response = await fetch('/audio-fixtures/manifest.json');
  if (!response.ok) throw new Error('Manifest unavailable');
  const source = parseManifest(await response.json());
  const count = Math.min(10000, Math.max(source.length, Number(new URLSearchParams(location.search).get('count')) || source.length));
  items = Array.from({ length: count }, (_, index) => source[index % source.length]);
  document.querySelector('.audio-count').textContent = String(items.length);
  layout();
} catch (error) {
  console.error(error);
  const message = document.querySelector('.load-error'); message.hidden = false; message.textContent = '音频暂时无法加载，请刷新重试。';
}
