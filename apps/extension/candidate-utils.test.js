import test from "node:test";
import assert from "node:assert/strict";
import "./candidate-utils.js";

const c = globalThis.BowerbirdCandidates;

test("drop HTML image wins over outer product page URL", () => {
  const page = "https://shop.example/products/collar";
  const image = "https://cdn.example/images/collar-1600.jpg";
  const result = c.dropCandidatesFromValues({
    base: page,
    uriList: page,
    plain: page,
    html: `<a href="${page}"><img src="${image}"></a>`,
  });
  assert.deepEqual(result.map((item) => item.url), [image]);
  assert.equal(result[0].kind, "image-url");
});

test("drop text URL becomes page-or-image only when HTML has no image", () => {
  const page = "https://shop.example/products/collar";
  const result = c.dropCandidatesFromValues({ base: page, uriList: page, plain: page, html: "<a>product</a>" });
  assert.equal(result.length, 1);
  assert.equal(result[0].url, page);
  assert.equal(result[0].kind, "page-or-image");
});

test("srcset selects highest descriptor", () => {
  const result = c.parseSrcset("small.jpg 400w, /large.jpg 1600w, retina.jpg 2x", "https://example.com/p/");
  assert.equal(result.url, "https://example.com/large.jpg");
});

test("srcset preserves commas in the winning CDN URL with a descriptor", () => {
  const result = c.parseSrcset(
    "small.jpg 400w, https://res.cloudinary.com/demo/image/upload/w_800,q_auto,f_auto/sample.jpg 800w, medium.jpg 600w",
    "https://example.com/p/"
  );
  assert.equal(result.url, "https://res.cloudinary.com/demo/image/upload/w_800,q_auto,f_auto/sample.jpg");
  assert.equal(result.score, 800);
});

test("srcset separates descriptorless candidates at trailing commas", () => {
  const result = c.parseSrcset("/a,b.jpg?crop=2,4, /preview.jpg .5x", "https://example.com/p/");
  assert.equal(result.url, "https://example.com/a,b.jpg?crop=2,4");
  assert.equal(c.parseSrcset("/a,b.jpg", "https://example.com").url, "https://example.com/a,b.jpg");
});

test("srcset accepts data images and discards invalid descriptors as whole candidates", () => {
  const dataUrl = "data:image/png;base64,AAAA";
  const result = c.parseSrcset(
    `bad.jpg invalid(1, pretend.jpg 900w), /mixed.jpg 900w 2x, ${dataUrl} 2e0x, /fallback.jpg 1x`,
    "https://example.com"
  );
  assert.equal(result.url, dataUrl);
  assert.equal(result.kind, "data");
});

test("normalization preserves query and drops fragment", () => {
  const result = c.normalizeCandidateUrl("/image.jpg?w=1200#hero", "https://example.com/page");
  assert.equal(result.url, "https://example.com/image.jpg?w=1200");
});

test("HTML entities in image URL are decoded", () => {
  const result = c.extractImageCandidatesFromHtml(
    '<img src="https://cdn.example/a.jpg?x=1&amp;y=2">',
    "https://example.com"
  );
  assert.equal(result[0].url, "https://cdn.example/a.jpg?x=1&y=2");
});

test("dedupe keeps highest priority and filters explicit 1x1 only when not explicit", () => {
  const base = "https://example.com";
  const result = c.rankAndDedupe([
    c.candidate("/a.jpg", base, { source: "lazy", priority: 20, width: 100, height: 100 }),
    c.candidate("/a.jpg", base, { source: "currentSrc", priority: 80, width: 800, height: 600 }),
    c.candidate("/pixel.gif", base, { source: "src", priority: 80, width: 1, height: 1 }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "currentSrc");
});

test("candidate list is capped at 100", () => {
  const list = Array.from({ length: 150 }, (_, i) =>
    c.candidate(`https://cdn.example/${i}.jpg`, "https://example.com", { priority: i })
  );
  assert.equal(c.rankAndDedupe(list).length, 100);
});

test("img tag with srcset+src emits only the highest-res variant (no duplicate resolutions)", () => {
  const result = c.extractImageCandidatesFromHtml(
    '<img src="https://cdn.example/thumb.jpg" srcset="https://cdn.example/thumb-236w.jpg 236w, https://cdn.example/full-736w.jpg 736w">',
    "https://example.com/page"
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].url, "https://cdn.example/full-736w.jpg");
  assert.equal(result[0].source, "drop-srcset");
});

test("img tag with src + data-src emits only one (no duplicate from lazy attrs)", () => {
  const result = c.extractImageCandidatesFromHtml(
    '<img src="https://cdn.example/a.jpg" data-src="https://cdn.example/a-lazy.jpg">',
    "https://example.com/page"
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].url, "https://cdn.example/a.jpg");
});

test("picture source and fallback img emit one logical image", () => {
  const result = c.extractImageCandidatesFromHtml(
    '<picture><source srcset="https://cdn.example/x-400w.jpg 400w, https://cdn.example/x-1200w.jpg 1200w"><img src="https://cdn.example/x-fallback.jpg"></picture>',
    "https://example.com/page"
  );
  // source 与 fallback img 同属一个 picture，只应采一张。
  assert.equal(result.length, 1);
  assert.equal(result[0].url, "https://cdn.example/x-1200w.jpg");
});

test("dragged HTML keeps images and excludes unrelated video source children", () => {
  const result = c.extractImageCandidatesFromHtml(
    '<img src="/image.jpg"><video poster="/poster.jpg"><source src="/clip.mp4" type="video/mp4"></video>',
    "https://example.com/page"
  );
  assert.deepEqual(result.map(item => item.url), ["https://example.com/image.jpg"]);
});
