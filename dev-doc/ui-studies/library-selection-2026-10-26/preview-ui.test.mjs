import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../apps/html-renderer/node_modules/playwright/index.mjs';
import { server } from './serve.mjs';

const output = fileURLToPath(new URL('./screenshots/corner-rays-2026-10-27/', import.meta.url));
await mkdir(output, { recursive: true });
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
  const galleryCards = page.locator('.gallery .asset');
  const reference = page.locator('.reference-card');
  const card = id => page.locator(`.gallery [data-asset="${id}"]`);
  const selected = () => page.locator('.gallery .asset[aria-pressed="true"]');
  const geometry = () => galleryCards.evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    return [box.x, box.y, box.width, box.height];
  }));
  const imageGeometry = () => galleryCards.evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect(), image = element.querySelector('img').getBoundingClientRect();
    return { selected: element.getAttribute('aria-pressed') === 'true', slot: { x: box.x, y: box.y, width: box.width, height: box.height }, image: { x: image.x, y: image.y, width: image.width, height: image.height } };
  }));
  const markState = () => reference.evaluate(element => {
    const offset = selector => {
      const part = element.querySelector(selector), matrix = new DOMMatrixReadOnly(getComputedStyle(part).transform);
      return [matrix.m41, matrix.m42];
    };
    return {
      left: offset('.bracket-left'), right: offset('.bracket-right'),
      ticks: ['left', 'right', 'top', 'bottom'].map(direction => offset(`.tick-${direction}`)),
      rotations: ['top-right', 'bottom-right', 'bottom-left', 'top-left'].map(corner => parseFloat(getComputedStyle(element.querySelector(`.ray-${corner}`)).rotate)),
      center: Number(getComputedStyle(element.querySelector('.center-lock')).opacity),
      signal: Number(getComputedStyle(element.querySelector('.selection-signal')).opacity),
    };
  });
  const seek = milliseconds => page.locator('#timeline').evaluate((element, value) => {
    element.value = String(value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, milliseconds);
  const unchangedImagePaint = () => galleryCards.evaluateAll(elements => elements.every(element => {
    const image = element.querySelector('img'), style = getComputedStyle(image);
    return style.opacity === '1' && style.filter === 'none' && getComputedStyle(element).opacity === '1';
  }));
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < .05, `${label}: expected ${expected}, received ${actual}`);
  async function verifyImageScale(label) {
    for (const { selected, slot, image } of await imageGeometry()) {
      near(image.width / slot.width, image.height / slot.height, `${label}: image scales uniformly`);
      near(image.x + image.width / 2, slot.x + slot.width / 2, `${label}: image stays centered horizontally`);
      near(image.y + image.height / 2, slot.y + slot.height / 2, `${label}: image stays centered vertically`);
      if (selected) assert.ok(image.width < slot.width && image.height < slot.height, `${label}: only the selected image shrinks within its unchanged slot`);
      else { near(image.width, slot.width, `${label}: unselected image fills its original width`); near(image.height, slot.height, `${label}: unselected image fills its original height`); }
    }
    assert.ok(await unchangedImagePaint(), `${label}: selection never flashes or filters the media itself`);
  }
  async function verifyOuterMarkers(label) {
    const markers = await selected().evaluateAll(elements => elements.map(element => {
      const rect = part => {
        const box = part.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
      };
      const image = rect(element.querySelector('img'));
      const brackets = ['left', 'right'].map(direction => {
        const path = element.querySelector(`.bracket-${direction} path`);
        return { ...rect(path), stroke: parseFloat(getComputedStyle(path).strokeWidth) };
      });
      const ticks = ['left', 'right', 'top', 'bottom'].map(direction => {
        const tick = element.querySelector(`.tick-${direction} i`);
        return { ...rect(tick), before: getComputedStyle(tick, '::before').content, after: getComputedStyle(tick, '::after').content };
      });
      const parts = [...brackets, ...ticks];
      return { id: element.dataset.asset, image, brackets, ticks, paint: { left: Math.min(...parts.map(part => part.left)), top: Math.min(...parts.map(part => part.top)), right: Math.max(...parts.map(part => part.right)), bottom: Math.max(...parts.map(part => part.bottom)) } };
    }));
    for (const { id, image, brackets, ticks } of markers) {
      assert.ok(brackets[0].right + brackets[0].stroke / 2 < image.left, `${label}: ${id} entire left bracket, including its end caps, is outside the image`);
      assert.ok(brackets[1].left - brackets[1].stroke / 2 > image.right, `${label}: ${id} entire right bracket is outside the image`);
      assert.ok(ticks[0].right < image.left && ticks[1].left > image.right && ticks[2].bottom < image.top && ticks[3].top > image.bottom, `${label}: ${id} all four white ticks are outside the actual image`);
      for (const [index, tick] of ticks.entries()) {
        assert.ok(index < 2 ? tick.width > tick.height * 3 : tick.height > tick.width * 3, `${label}: ${id} ${index < 2 ? 'side ticks are horizontal' : 'top and bottom ticks are vertical'}`);
        assert.equal(tick.before, 'none', `${label}: tick has no second cross arm`);
        assert.equal(tick.after, 'none', `${label}: tick has no second cross arm`);
      }
    }
    for (let i = 0; i < markers.length; i++) for (let j = i + 1; j < markers.length; j++) {
      const a = markers[i].paint, b = markers[j].paint;
      assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, `${label}: selected markers ${markers[i].id}/${markers[j].id} do not overlap`);
    }
    assert.equal(await page.locator('.short-cross').count(), 0, `${label}: no four-way short cross remains`);
    assert.equal(await page.locator('.gallery').evaluate(element => getComputedStyle(element).gap), '8px', `${label}: preview uses the real 8px media gap`);
  }
  async function verifyCornerRays(label) {
    const marks = await page.locator('.asset[aria-pressed="true"]').evaluateAll(elements => elements.map(element => {
      const rect = part => {
        const box = part.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
      };
      const image = rect(element.querySelector('img') ?? element.querySelector('.selection-mark'));
      const lock = rect(element.querySelector('.center-lock'));
      const reticle = getComputedStyle(element.querySelector('.reticle'));
      const rays = ['top-right', 'bottom-right', 'bottom-left', 'top-left'].map(corner => {
        const ray = element.querySelector(`.ray-${corner}`), style = getComputedStyle(ray), line = getComputedStyle(ray, '::after');
        return { corner, angle: parseFloat(style.rotate), width: parseFloat(style.width), height: parseFloat(style.height), bounds: rect(ray), start: parseFloat(line.left), length: parseFloat(line.width), thickness: parseFloat(line.height), color: line.backgroundColor, opacity: style.opacity, lineOpacity: line.opacity };
      });
      return { id: element.dataset.asset, image, lock, rays, reticleRotate: reticle.rotate, reticleTransform: reticle.transform, reticleOpacity: reticle.opacity };
    }));
    for (const { id, image, lock, rays, reticleRotate, reticleTransform, reticleOpacity } of marks) {
      const center = { x: image.left + image.width / 2, y: image.top + image.height / 2 };
      const corners = [{ x: image.right, y: image.top }, { x: image.right, y: image.bottom }, { x: image.left, y: image.bottom }, { x: image.left, y: image.top }];
      const diagonalAngle = Math.atan2(image.height, image.width) * 180 / Math.PI;
      const expected = [-diagonalAngle, diagonalAngle, 180 - diagonalAngle, 180 + diagonalAngle];
      assert.equal(reticleRotate, 'none', `${label}: ${id} reticle does not impose a second overall rotation`);
      assert.equal(reticleTransform, 'none', `${label}: ${id} each line owns its angle`);
      assert.equal(reticleOpacity, '1', `${label}: ${id} white rays are not dimmed to gray`);
      for (const [index, ray] of rays.entries()) {
        near(ray.angle, expected[index], `${label}: ${id} ${ray.corner} follows the actual image corner`);
        assert.equal(ray.color, 'rgb(247, 248, 246)', `${label}: ${id} ${ray.corner} is white`);
        assert.equal(ray.opacity, '1'); assert.equal(ray.lineOpacity, '1');
        assert.ok(ray.length > 0 && ray.thickness > 0 && ray.length > ray.thickness * 4, `${label}: ${id} ${ray.corner} renders a real line segment`);
        const radians = ray.angle * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
        const localCorners = [[0, -ray.height / 2], [ray.width, -ray.height / 2], [ray.width, ray.height / 2], [0, ray.height / 2]];
        const pivot = { x: ray.bounds.left - Math.min(...localCorners.map(([x, y]) => x * cos - y * sin)), y: ray.bounds.top - Math.min(...localCorners.map(([x, y]) => x * sin + y * cos)) };
        near(pivot.x, center.x, `${label}: ${id} ${ray.corner} pivots at the image center X`);
        near(pivot.y, center.y, `${label}: ${id} ${ray.corner} pivots at the image center Y`);
        const start = { x: pivot.x + ray.start * cos, y: pivot.y + ray.start * sin };
        const gap = Math.hypot(Math.max(lock.left - start.x, 0, start.x - lock.right), Math.max(lock.top - start.y, 0, start.y - lock.bottom)) - ray.thickness / 2;
        assert.ok(gap > 2.5, `${label}: ${id} ${ray.corner} stays visibly detached from the center square (${gap}px)`);
        const target = corners[index], dx = target.x - pivot.x, dy = target.y - pivot.y;
        assert.ok(dx * cos + dy * sin > 0, `${label}: ${id} ${ray.corner} points outward toward its corner`);
        assert.ok(Math.abs(dx * sin - dy * cos) < .05, `${label}: ${id} ${ray.corner} line intersects its real image corner`);
      }
    }
  }

  assert.equal(await selected().count(), 2);
  const initialGeometry = await geometry();
  const terminal = await markState();
  const frames = [];
  for (const milliseconds of [0, 75, 150, 225, 300]) {
    await seek(milliseconds);
    const state = await markState();
    frames.push(state);
    assert.equal(await page.locator('#time').textContent(), `${milliseconds} ms`);
    assert.deepEqual(await geometry(), initialGeometry, `selection at ${milliseconds}ms preserves every card slot`);
    await verifyImageScale(`frame ${milliseconds}ms`);
    const frozenAnimations = await reference.evaluate(element => {
      const animations = element.querySelector('.selection-mark').getAnimations({ subtree: true });
      return animations.map(animation => ({ name: animation.animationName, state: animation.playState, currentTime: animation.currentTime, endTime: animation.effect.getComputedTiming().endTime }));
    });
    assert.ok(frozenAnimations.length === 12 && frozenAnimations.every(animation => animation.state === 'paused' && animation.currentTime === milliseconds && Math.abs(animation.endTime - 300) < .01), `all selection parts are deterministically frozen at ${milliseconds}ms within one 300ms envelope: ${JSON.stringify(frozenAnimations)}`);
    await page.screenshot({ path: `${output}/frame-${String(milliseconds).padStart(3, '0')}.png`, fullPage: true });
  }
  const referenceWidth = await reference.locator('.selection-mark').evaluate(element => element.getBoundingClientRect().width);
  const referenceHeight = await reference.locator('.selection-mark').evaluate(element => element.getBoundingClientRect().height);
  near(frames[0].left[0], referenceWidth * .5, 'left bracket starts at the center');
  near(frames[0].right[0], -referenceWidth * .5, 'right bracket starts at the center');
  near(frames[0].ticks[0][0], referenceWidth * .5, 'left horizontal tick starts at the center');
  near(frames[0].ticks[1][0], -referenceWidth * .5, 'right horizontal tick starts at the center');
  near(frames[0].ticks[2][1], referenceHeight * .5, 'top vertical tick starts at the center');
  near(frames[0].ticks[3][1], -referenceHeight * .5, 'bottom vertical tick starts at the center');
  assert.deepEqual(frames[0].rotations, [-90, 0, 90, 180], 'four white rays begin as an axial cross');
  assert.equal(frames[0].center, 0);
  for (let i = 1; i < frames.length; i++) {
    assert.ok(frames[i].left[0] < frames[i - 1].left[0] && frames[i].right[0] > frames[i - 1].right[0], 'brackets move from center toward opposite edges');
    assert.ok(frames[i].ticks[2][1] < frames[i - 1].ticks[2][1] && frames[i].ticks[3][1] > frames[i - 1].ticks[3][1], 'vertical ticks expand outward');
    assert.ok(frames[i].rotations.every((angle, index) => angle > frames[i - 1].rotations[index]), 'four white rays rotate independently from the cross toward their image corners');
    assert.ok(frames[i].center >= frames[i - 1].center, 'center lock fades in without reversing');
  }
  assert.deepEqual(frames.at(-1), terminal, '300ms is the persistent selected state');
  await verifyOuterMarkers('300ms terminal');
  await verifyCornerRays('300ms terminal');
  await reference.screenshot({ path: `${output}/mark-300.png` });
  const pulses = [];
  for (const milliseconds of [150, 190, 230, 270, 300]) { await seek(milliseconds); pulses.push((await markState()).signal); }
  assert.ok(pulses[0] < pulses[1] && pulses[2] < pulses[3] && pulses[4] === 1, 'two short decoration-only pulses finish fully visible');

  await page.getByRole('button', { name: '重播动效', exact: true }).click();
  await page.waitForTimeout(360);
  assert.deepEqual(await markState(), terminal, 'natural playback completes in approximately 300ms');
  assert.ok(await reference.evaluate(element => element.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running')), 'selection does not loop after completion');
  await page.waitForTimeout(350);
  assert.deepEqual(await markState(), terminal, 'selected state remains steady after completion');

  await card('2').click();
  assert.equal(await selected().count(), 3, 'a new selection keeps prior selections');
  await card('4').click();
  assert.equal(await selected().count(), 4);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(360);
  assert.deepEqual(await geometry(), initialGeometry, 'adjacent selections preserve the gallery slots');
  await verifyImageScale('all four selected');
  await verifyOuterMarkers('adjacent selected cards');
  await verifyCornerRays('portrait, landscape and square selected together');
  await card('3').hover();
  await page.waitForTimeout(220);
  await verifyOuterMarkers('selected card with hover lift');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(220);
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  assert.equal(await selected().count(), 0);
  assert.equal(await page.locator('.gallery .selection-mark').count(), 0, 'deselecting removes all overlay fragments');
  await page.waitForTimeout(360);
  await verifyImageScale('cleared selection restores original media geometry');
  assert.deepEqual(await geometry(), initialGeometry, 'clearing selection never reallocates a card slot');
  await card('2').evaluate(element => { for (let i = 0; i < 7; i++) element.click(); });
  assert.equal(await card('2').getAttribute('aria-pressed'), 'true');
  assert.equal(await card('2').locator('.selection-mark').count(), 1, 'rapid toggling does not accumulate overlays');
  await page.waitForTimeout(350);
  assert.ok(await card('2').evaluate(element => element.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running')));
  assert.equal(await page.locator('#selection-count').textContent(), '已选 1 项');
  assert.ok(await card('2').evaluate(element => [...element.querySelectorAll('.selection-mark, .selection-mark *')].every(part => getComputedStyle(part).pointerEvents === 'none')), 'all decoration descendants ignore pointer input');
  await card('2').click({ position: { x: 8, y: 8 } });
  assert.equal(await card('2').getAttribute('aria-pressed'), 'false', 'the overlaid bracket area still activates the underlying card');
  await card('2').click();
  assert.equal(await card('2').getAttribute('aria-pressed'), 'true', 'the center lock also permits card selection');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(360);
  assert.deepEqual(await geometry(), initialGeometry, 'multi-selection and cancellation leave gallery geometry unchanged');
  await verifyImageScale('after repeated selection toggles');

  await galleryCards.evaluateAll(elements => elements.forEach(element => { if (element.getAttribute('aria-pressed') !== 'true') element.click(); }));
  await page.waitForTimeout(360);

  const originalLandscapeAngle = await card('3').locator('.ray-bottom-right').evaluate(element => parseFloat(getComputedStyle(element).rotate));
  await card('3').evaluate(element => { element.style.aspectRatio = '9 / 16'; });
  await page.waitForFunction(() => {
    const card = document.querySelector('[data-asset="3"]'), image = card.querySelector('img').getBoundingClientRect();
    return image.height > image.width && Math.abs(parseFloat(getComputedStyle(card.querySelector('.ray-bottom-right')).rotate) - Math.atan2(image.height, image.width) * 180 / Math.PI) < .01;
  });
  await verifyCornerRays('aspect ratio changed from landscape to portrait');
  assert.ok(await card('3').locator('.ray-bottom-right').evaluate((element, original) => Math.abs(parseFloat(getComputedStyle(element).rotate) - original) > 20, originalLandscapeAngle), 'ResizeObserver changes the ray angle when the image aspect ratio changes');
  await card('3').evaluate(element => { element.style.removeProperty('aspect-ratio'); });
  await page.waitForFunction(original => Math.abs(parseFloat(getComputedStyle(document.querySelector('[data-asset="3"] .ray-bottom-right')).rotate) - original) < .01, originalLandscapeAngle);
  await verifyCornerRays('original landscape aspect ratio restored');

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await verifyImageScale(`${theme} ${width}px`);
      await verifyOuterMarkers(`${theme} ${width}px`);
      await verifyCornerRays(`${theme} ${width}px resized viewport`);
      await page.screenshot({ path: `${output}/${theme}-${width}.png`, fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), `${theme} ${width}px preview has no horizontal overflow`);
      assert.equal(await page.evaluate(() => innerWidth - document.documentElement.clientWidth), 0, `${theme} ${width}px scrollbar reserves no width`);
      assert.ok(await galleryCards.evaluateAll(elements => elements.every(element => {
        const box = element.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth && box.width > 0 && box.width <= 230 && box.height > 0;
      })), `${theme} ${width}px every thumbnail fits the content width`);
    }
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '重播动效', exact: true }).click();
  assert.deepEqual(await markState(), terminal, 'reduced motion displays the terminal lock immediately');
  await verifyCornerRays('reduced motion terminal');
  assert.equal(await page.locator('.selection-mark').evaluateAll(elements => elements.flatMap(element => element.getAnimations({ subtree: true })).length), 0);
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  await card('1').click();
  const reducedState = await card('1').evaluate(element => ({ translate: getComputedStyle(element).translate, centerOpacity: getComputedStyle(element.querySelector('.center-lock')).opacity, animations: element.getAnimations({ subtree: true }).length }));
  assert.deepEqual(reducedState, { translate: 'none', centerOpacity: '1', animations: 0 }, 'a new reduced-motion selection is fully visible without motion or hover translation');
  await verifyCornerRays('new reduced motion selection');
  await page.screenshot({ path: `${output}/reduced-motion-390.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS corner-ray selection preview: four independent white corner-aligned rays with center clearance, dynamic image ratios and viewport resize, five frozen 300ms frames, two decoration-only flashes, external markers, uniformly inset images with stable slots, rapid toggles/click-through, light/dark desktop/mobile and reduced motion.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
