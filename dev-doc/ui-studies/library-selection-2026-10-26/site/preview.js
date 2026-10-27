const cards = [...document.querySelectorAll('.asset')];
const reference = document.querySelector('.reference-card');
const timeline = document.querySelector('#timeline');
const time = document.querySelector('#time');
const speed = document.querySelector('#speed');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let playbackFrame = 0;

function updateReticle(card) {
  const mark = card.querySelector('.selection-mark');
  if (!mark) return;
  const { width, height } = (card.querySelector('img') ?? mark).getBoundingClientRect();
  mark.style.setProperty('--corner-angle', `${Math.atan2(height, width) * 180 / Math.PI}deg`);
}
const cardResizeObserver = new ResizeObserver(entries => entries.forEach(entry => updateReticle(entry.target)));

function setSelected(card, selected, animate = true) {
  card.querySelector('.selection-mark')?.remove();
  card.setAttribute('aria-pressed', String(selected));
  if (selected) {
    card.append(document.querySelector('#selection-mark').content.cloneNode(true));
    updateReticle(card);
    if (animate && !reducedMotion.matches) {
      const mark = card.querySelector('.selection-mark');
      mark.classList.add('is-entering');
      mark.getAnimations({ subtree:true }).forEach(animation => animation.playbackRate = Number(speed.value));
    }
  }
  const count = document.querySelectorAll('.gallery .asset[aria-pressed="true"]').length;
  document.querySelector('#selection-count').textContent = `已选 ${count} 项`;
}
function replay() {
  cancelAnimationFrame(playbackFrame);
  cards.filter(card => card === reference || card.getAttribute('aria-pressed') === 'true').forEach(card => setSelected(card, true));
  const start = performance.now();
  function update(now) {
    const progress = reducedMotion.matches ? 300 : Math.min(300, (now - start) * Number(speed.value));
    timeline.value = String(Math.round(progress)); time.value = `${Math.round(progress)} ms`;
    if (progress < 300) playbackFrame = requestAnimationFrame(update);
  }
  playbackFrame = requestAnimationFrame(update);
}
cards.forEach(card => {
  setSelected(card, card.getAttribute('aria-pressed') === 'true', false);
  cardResizeObserver.observe(card);
  card.addEventListener('click', () => card === reference ? replay() : setSelected(card, card.getAttribute('aria-pressed') !== 'true'));
});
document.querySelector('#replay').addEventListener('click', replay);
speed.addEventListener('change', replay);
document.querySelector('#clear').addEventListener('click', () => cards.filter(card => card !== reference).forEach(card => setSelected(card, false)));
document.querySelector('#theme').addEventListener('click', event => {
  const light = document.documentElement.dataset.theme !== 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  event.currentTarget.textContent = light ? '切换深色' : '切换浅色';
});
timeline.addEventListener('input', () => {
  cancelAnimationFrame(playbackFrame);
  cards.filter(card => card.getAttribute('aria-pressed') === 'true').forEach(card => {
    setSelected(card, true);
    card.querySelector('.selection-mark').getAnimations({ subtree:true }).forEach(animation => { animation.pause(); animation.currentTime = Number(timeline.value); });
  });
  time.value = `${timeline.value} ms`;
});
reducedMotion.addEventListener('change', () => cards.forEach(card => setSelected(card, card.getAttribute('aria-pressed') === 'true', false)));
