import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSourceAddress, sourceDiscoveryFor } from "../src/lib/sourceDiscovery.ts";

test("Pinterest sources expose the native recommendation action", () => {
  const result = sourceDiscoveryFor("https://www.pinterest.com/pin/123456/");

  assert.equal(result?.actionLabel, "在 Pinterest 发现更多");
  assert.match(result?.hint || "", /Pinterest 相关推荐/);
});

test("Pinterest short links are classified without following redirects", () => {
  const result = sourceDiscoveryFor("https://pin.it/abc123");

  assert.equal(result?.actionLabel, "在 Pinterest 发现更多");
});

test("generic sources stay honest about only opening the source page", () => {
  const result = sourceDiscoveryFor("https://example.com/inspiration/42");

  assert.equal(result?.actionLabel, "在应用内浏览来源");
  assert.equal(result?.hint, "继续查看 example.com 的原始页面");
});

test("malformed and non-web URLs do not create discovery actions", () => {
  assert.equal(sourceDiscoveryFor("not a url"), null);
  assert.equal(sourceDiscoveryFor("file:///tmp/private.png"), null);
  assert.equal(sourceDiscoveryFor("javascript:alert(1)"), null);
});

test("typed addresses stay inside the HTTP(S)-only browser boundary", () => {
  assert.equal(normalizeSourceAddress("pinterest.com/pin/123"), "https://pinterest.com/pin/123");
  assert.equal(normalizeSourceAddress("https://example.com/path"), "https://example.com/path");
  assert.equal(normalizeSourceAddress("file:///tmp/private.png"), null);
  assert.equal(normalizeSourceAddress("https://user:secret@example.com"), null);
});
