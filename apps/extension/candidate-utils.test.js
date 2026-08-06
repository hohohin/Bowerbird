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
