/**
 * 资源尺寸声明解析单测 —— H5-T1 解压炸弹防护。
 * PNG 用真编码 fixture；JPEG/WebP 手造头部字节（只测解析，不需完整图片）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredImageDimensions, withinResourceDimensionLimits } from "./image-dimensions.ts";
import { encodePng } from "./png.ts";

function solidRgba(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  out.fill(255);
  return out;
}

test("png dimensions from real fixture", () => {
  const png = encodePng({ width: 21, height: 9, rgba: solidRgba(21, 9) });
  assert.deepEqual(declaredImageDimensions(png, "image/png"), { width: 21, height: 9 });
});

test("png bomb header: tiny bytes, huge declared canvas is read and rejected by limits", () => {
  // 33 字节：签名 + IHDR 声称 40000x40000（CRC 字节为垃圾——宽松解析不校验）。
  const bomb = new Uint8Array(33);
  bomb.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bomb.set([0, 0, 0, 13], 8); // length
  bomb.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
  view.setUint32(16, 40000);
  view.setUint32(20, 40000);
  const dims = declaredImageDimensions(bomb, "image/png");
  assert.deepEqual(dims, { width: 40000, height: 40000 });
  assert.equal(withinResourceDimensionLimits(dims!, { maxSidePx: 32768, maxPixels: 64 * 1024 * 1024 }), false);
});

test("jpeg dimensions from minimal SOF0 stream", () => {
  const bytes = new Uint8Array([
    0xff, 0xd8,              // SOI
    0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, // APP0 段（len=4）
    0xff, 0xc0, 0x00, 0x0b,  // SOF0 len=11
    0x08,                    // precision
    0x01, 0xe0,              // height=480
    0x02, 0x80,              // width=640
    0x03,                    // components
  ]);
  assert.deepEqual(declaredImageDimensions(bytes, "image/jpeg"), { width: 640, height: 480 });
});

test("jpeg without SOF fails closed", () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x00, 0x00]);
  assert.equal(declaredImageDimensions(bytes, "image/jpeg"), null);
});

test("webp VP8X canvas dimensions", () => {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  const view = new DataView(bytes.buffer);
  // canvas-1: width-1=999 (0x3E7), height-1=599 (0x257)
  bytes[24] = 0xe7; bytes[25] = 0x03; bytes[26] = 0x00;
  bytes[27] = 0x57; bytes[28] = 0x02; bytes[29] = 0x00;
  assert.deepEqual(declaredImageDimensions(bytes, "image/webp"), { width: 1000, height: 600 });
  void view;
});

test("webp VP8L dimensions", () => {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12); // VP8L
  // 14bit width-1=63, 14bit height-1=127
  const bits = (63) | (127 << 14);
  const view = new DataView(bytes.buffer);
  view.setUint32(21, bits, true);
  assert.deepEqual(declaredImageDimensions(bytes, "image/webp"), { width: 64, height: 128 });
});

test("garbage bytes fail closed for all mimes", () => {
  const junk = new Uint8Array(64).fill(0x41);
  assert.equal(declaredImageDimensions(junk, "image/png"), null);
  assert.equal(declaredImageDimensions(junk, "image/jpeg"), null);
  assert.equal(declaredImageDimensions(junk, "image/webp"), null);
});
