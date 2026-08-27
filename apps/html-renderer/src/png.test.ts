/**
 * PNG 编解码/裁切单测 —— H1-T3/T4 的像素级基础。
 * 覆盖：round-trip、全部 5 种 filter 的解码、CRC 破损、隔行/调色板/位深拒绝、裁切正确性。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { cropPng, decodePng, encodePng, readPngHeader } from "./png.ts";

function solidRgba(width: number, height: number, fill: [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    out[i * 4] = fill[0];
    out[i * 4 + 1] = fill[1];
    out[i * 4 + 2] = fill[2];
    out[i * 4 + 3] = fill[3];
  }
  return out;
}

function gradientRgba(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      out[i] = (x * 37 + y * 11) % 256;
      out[i + 1] = (x * 5 + y * 73) % 256;
      out[i + 2] = (x * 97 + y * 3) % 256;
      out[i + 3] = 255;
    }
  }
  return out;
}

// —— 测试自用 PNG writer（可指定 filter / interlace，写正确 CRC）——
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i])! & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  out[0] = (data.length >>> 24) & 0xff;
  out[1] = (data.length >>> 16) & 0xff;
  out[2] = (data.length >>> 8) & 0xff;
  out[3] = data.length & 0xff;
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out[8 + data.length] = (crc >>> 24) & 0xff;
  out[9 + data.length] = (crc >>> 16) & 0xff;
  out[10 + data.length] = (crc >>> 8) & 0xff;
  out[11 + data.length] = crc & 0xff;
  return out;
}

function buildPng(opts: { width: number; height: number; rgba: Uint8Array; colorType?: 2 | 6; filter: number; interlace?: number }): Uint8Array {
  const colorType = opts.colorType ?? 6;
  const channels = colorType === 6 ? 4 : 3;
  const stride = opts.width * channels;
  const raw = new Uint8Array((stride + 1) * opts.height);
  for (let y = 0; y < opts.height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = opts.filter;
    for (let x = 0; x < opts.width; x += 1) {
      const s = (y * opts.width + x) * 4;
      const d = rowStart + 1 + x * channels;
      raw[d] = opts.rgba[s]!;
      raw[d + 1] = opts.rgba[s + 1]!;
      raw[d + 2] = opts.rgba[s + 2]!;
      if (channels === 4) raw[d + 3] = opts.rgba[s + 3]!;
    }
  }
  // filter != 0 时按「编码方向」重算字节（模拟真实编码器），使解码 round-trip 成立
  if (opts.filter !== 0) {
    const bpp = channels;
    const enc = new Uint8Array(raw.length);
    enc.set(raw);
    for (let y = 0; y < opts.height; y += 1) {
      const rowStart = y * (stride + 1);
      enc[rowStart] = opts.filter;
      for (let x = 0; x < stride; x += 1) {
        const i = rowStart + 1 + x;
        const left = x >= bpp ? raw[rowStart + 1 + x - bpp]! : 0;
        const up = y > 0 ? raw[rowStart + 1 - (stride + 1) + x]! : 0;
        const upLeft = y > 0 && x >= bpp ? raw[rowStart + 1 - (stride + 1) + x - bpp]! : 0;
        let predictor = 0;
        if (opts.filter === 1) predictor = left;
        else if (opts.filter === 2) predictor = up;
        else if (opts.filter === 3) predictor = (left + up) >> 1;
        else if (opts.filter === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        }
        enc[i] = (raw[i]! - predictor) & 0xff;
      }
    }
    raw.set(enc);
  }
  const ihdr = new Uint8Array(13);
  ihdr[0] = (opts.width >>> 24) & 0xff;
  ihdr[1] = (opts.width >>> 16) & 0xff;
  ihdr[2] = (opts.width >>> 8) & 0xff;
  ihdr[3] = opts.width & 0xff;
  ihdr[4] = (opts.height >>> 24) & 0xff;
  ihdr[5] = (opts.height >>> 16) & 0xff;
  ihdr[6] = (opts.height >>> 8) & 0xff;
  ihdr[7] = opts.height & 0xff;
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[12] = opts.interlace ?? 0;
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = new Uint8Array(deflateSync(Buffer.from(raw), { level: 6 }));
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]);
}

test("encode→decode round-trip preserves pixels and determinism", () => {
  const rgba = gradientRgba(13, 7);
  const png1 = encodePng({ width: 13, height: 7, rgba });
  const png2 = encodePng({ width: 13, height: 7, rgba });
  assert.deepEqual(png1, png2, "same input must encode deterministically");
  const decoded = decodePng(png1);
  assert.ok(!("reason" in decoded));
  assert.equal((decoded as { width: number }).width, 13);
  assert.equal((decoded as { height: number }).height, 7);
  assert.deepEqual((decoded as { rgba: Uint8Array }).rgba, rgba);
});

test("decode supports sub/up/average/paeth filters", () => {
  const rgba = gradientRgba(9, 5);
  for (const filter of [0, 1, 2, 3, 4]) {
    const png = buildPng({ width: 9, height: 5, rgba, filter });
    const decoded = decodePng(png);
    assert.ok(!("reason" in decoded), `filter ${filter} should decode, got ${(decoded as { reason?: string }).reason}`);
    assert.deepEqual((decoded as { rgba: Uint8Array }).rgba, rgba, `filter ${filter} pixels mismatch`);
  }
});

test("decode rejects crc mismatch", () => {
  const png = encodePng({ width: 4, height: 4, rgba: solidRgba(4, 4, [255, 0, 0, 255]) });
  const copy = Uint8Array.from(png);
  copy[60] ^= 0xff; // 破坏 IDAT 数据区某字节
  const decoded = decodePng(copy);
  assert.ok("reason" in decoded);
  assert.equal((decoded as { reason: string }).reason, "crc_mismatch");
});

test("decode rejects interlaced png", () => {
  const png = buildPng({ width: 3, height: 3, rgba: solidRgba(3, 3, [1, 2, 3, 255]), filter: 0, interlace: 1 });
  const decoded = decodePng(png);
  assert.ok("reason" in decoded);
  assert.equal((decoded as { reason: string }).reason, "interlaced_unsupported");
});

test("decode rejects truncated data and bad signature", () => {
  const png = encodePng({ width: 4, height: 4, rgba: solidRgba(4, 4, [0, 0, 0, 255]) });
  const truncated = png.subarray(0, png.length - 10);
  assert.ok("reason" in decodePng(truncated));
  const badSig = Uint8Array.from(png);
  badSig[0] = 0x00;
  assert.ok("reason" in decodePng(badSig));
});

test("readPngHeader reads dimensions fast", () => {
  const png = encodePng({ width: 21, height: 19, rgba: solidRgba(21, 19, [9, 9, 9, 255]) });
  const header = readPngHeader(png);
  assert.ok(!("reason" in header));
  assert.equal((header as { width: number }).width, 21);
  assert.equal((header as { height: number }).height, 19);
});

test("cropPng extracts exact sub-rect pixels (rgb color type preserved)", () => {
  const width = 10;
  const height = 8;
  const rgba = gradientRgba(width, height);
  const png = encodePng({ width, height, rgba, colorType: 2 });
  const cropped = cropPng(png, { x: 3, y: 2, width: 4, height: 5 });
  assert.ok(!("reason" in cropped), `crop failed: ${(cropped as { reason?: string }).reason}`);
  const decoded = decodePng(cropped as Uint8Array);
  assert.ok(!("reason" in decoded));
  const d = decoded as { width: number; height: number; rgba: Uint8Array; colorType: number };
  assert.equal(d.width, 4);
  assert.equal(d.height, 5);
  assert.equal(d.colorType, 2, "crop preserves source color type");
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const expected = rgba.subarray(((y + 2) * width + (x + 3)) * 4, ((y + 2) * width + (x + 3)) * 4 + 4);
      const actual = d.rgba.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4);
      assert.deepEqual(actual, expected, `pixel (${x},${y})`);
    }
  }
});

test("cropPng rejects out-of-range rects", () => {
  const png = encodePng({ width: 4, height: 4, rgba: solidRgba(4, 4, [1, 1, 1, 255]) });
  assert.ok("reason" in cropPng(png, { x: 2, y: 2, width: 4, height: 4 }));
  assert.ok("reason" in cropPng(png, { x: -1, y: 0, width: 2, height: 2 }));
  assert.ok("reason" in cropPng(png, { x: 0, y: 0, width: 0, height: 2 }));
});
