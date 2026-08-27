/**
 * 最小 PNG 编解码器（纯 Node stdlib）—— H1-T3/T4。
 *
 * 用途：
 *   1. 校验 Chromium 截图（签名、IHDR 尺寸、CRC、可解码）；
 *   2. 从唯一整页像素结果裁出纵向切片（§2.3：禁止滚动后重复截图）；
 *   3. 切片复原测试的像素级对账。
 *
 * 支持范围刻意收窄到 renderer 自产 PNG + 测试 fixture：
 *   - bit depth 8、非隔行（interlace 0）；
 *   - color type 0（灰）/2（RGB）/4（灰+α）/6（RGBA）；
 *   - palette（type 3）与隔行直接拒绝（Chromium 不产出）。
 * 编码固定：filter 0 + zlib level 6，同输入同输出（可复现边界的一部分）。
 */
import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PngChannels = 1 | 2 | 3 | 4;

export type DecodedPng = {
  width: number;
  height: number;
  /** 原始 color type（裁切再编码时保持不变）。 */
  colorType: number;
  channels: PngChannels;
  /** 行主序像素；灰度按 RGBA 展开时由解码器复制到 RGB 通道。 */
  rgba: Uint8Array;
};

export type PngError = { reason: string };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function channelsFor(colorType: number): PngChannels | undefined {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return undefined;
}

/** 只读 IHDR：快速拿到宽高与 color type（不做完整解码）。签名/CRC 不在此校验。 */
export function readPngHeader(buf: Uint8Array): { width: number; height: number; colorType: number } | PngError {
  if (buf.length < 8 || !signatureMatches(buf)) return { reason: "signature" };
  if (buf.length < 33) return { reason: "truncated" };
  const firstType = ascii(buf, 12, 16);
  if (firstType !== "IHDR") return { reason: "ihdr_missing" };
  const width = readU32(buf, 16);
  const height = readU32(buf, 20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  if (width === 0 || height === 0) return { reason: "zero_dimension" };
  if (bitDepth !== 8) return { reason: "unsupported_bit_depth" };
  if (interlace !== 0) return { reason: "interlaced_unsupported" };
  if (channelsFor(colorType) === undefined) return { reason: "unsupported_color_type" };
  return { width, height, colorType };
}

export function isPngSignature(buf: Uint8Array): boolean {
  return signatureMatches(buf);
}

export function decodePng(buf: Uint8Array): DecodedPng | PngError {
  if (buf.length < 8 || !signatureMatches(buf)) return { reason: "signature" };
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let channels: PngChannels = 4;
  const idatParts: Uint8Array[] = [];
  let sawIend = false;
  while (offset + 12 <= buf.length) {
    const length = readU32(buf, offset);
    if (offset + 12 + length > buf.length) return { reason: "chunk_overrun" };
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    const expectedCrc = readU32(buf, crcOffset);
    const actualCrc = crc32(buf, typeStart, dataEnd);
    if (expectedCrc !== actualCrc) return { reason: "crc_mismatch" };
    const type = ascii(buf, typeStart, dataStart);
    if (type === "IHDR") {
      width = readU32(buf, dataStart);
      height = readU32(buf, dataStart + 4);
      const bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      const compression = buf[dataStart + 10];
      const filter = buf[dataStart + 11];
      const interlace = buf[dataStart + 12];
      if (bitDepth !== 8) return { reason: "unsupported_bit_depth" };
      if (compression !== 0 || filter !== 0) return { reason: "unsupported_compression_or_filter" };
      if (interlace !== 0) return { reason: "interlaced_unsupported" };
      const ch = channelsFor(colorType);
      if (ch === undefined) return { reason: "unsupported_color_type" };
      channels = ch;
      if (width === 0 || height === 0) return { reason: "zero_dimension" };
    } else if (type === "IDAT") {
      idatParts.push(buf.subarray(dataStart, dataEnd));
    } else if (type === "PLTE" || type === "tRNS") {
      return { reason: "palette_unsupported" };
    } else if (type === "IEND") {
      sawIend = true;
      break;
    }
    offset = crcOffset + 4;
  }
  if (width === 0 || !sawIend) return { reason: "truncated" };
  if (idatParts.length === 0) return { reason: "idat_missing" };

  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idatParts.map((p) => Buffer.from(p))));
  } catch {
    return { reason: "zlib_inflate_failed" };
  }
  const bpp = channels;
  const stride = width * bpp;
  const expected = (stride + 1) * height;
  if (raw.length !== expected) return { reason: "idat_length" };

  const pixels = new Uint8Array(stride * height);
  const lineStart = new Int32Array(height);
  for (let y = 0; y < height; y += 1) {
    lineStart[y] = y * (stride + 1);
  }
  for (let y = 0; y < height; y += 1) {
    const filter = raw[lineStart[y]];
    const srcStart = lineStart[y] + 1;
    const dstStart = y * stride;
    const priorStart = dstStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[srcStart + x];
      const left = x >= bpp ? pixels[dstStart + x - bpp] : 0;
      const up = y > 0 ? pixels[priorStart + x] : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[priorStart + x - bpp] : 0;
      let recon: number;
      switch (filter) {
        case 0:
          recon = value;
          break;
        case 1:
          recon = value + left;
          break;
        case 2:
          recon = value + up;
          break;
        case 3:
          recon = value + ((left + up) >> 1);
          break;
        case 4:
          recon = value + paeth(left, up, upLeft);
          break;
        default:
          return { reason: "unknown_filter" };
      }
      pixels[dstStart + x] = recon & 0xff;
    }
  }
  return { width, height, colorType, channels, rgba: toRgba(pixels, width, height, channels) };
}

function toRgba(pixels: Uint8Array, width: number, height: number, channels: PngChannels): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 4) {
      out[d] = pixels[s];
      out[d + 1] = pixels[s + 1];
      out[d + 2] = pixels[s + 2];
      out[d + 3] = pixels[s + 3];
    } else if (channels === 3) {
      out[d] = pixels[s];
      out[d + 1] = pixels[s + 1];
      out[d + 2] = pixels[s + 2];
      out[d + 3] = 255;
    } else if (channels === 2) {
      out[d] = pixels[s];
      out[d + 1] = pixels[s];
      out[d + 2] = pixels[s];
      out[d + 3] = pixels[s + 1];
    } else {
      out[d] = pixels[s];
      out[d + 1] = pixels[s];
      out[d + 2] = pixels[s];
      out[d + 3] = 255;
    }
  }
  return out;
}

export type EncodePngInput = {
  width: number;
  height: number;
  /** RGBA 行主序（宽×高×4）。 */
  rgba: Uint8Array;
  /** 目标 color type：2（RGB，丢 α）/ 6（RGBA）。默认 6。 */
  colorType?: 2 | 6;
};

export function encodePng(input: EncodePngInput): Uint8Array {
  const colorType = input.colorType ?? 6;
  const channels = colorType === 6 ? 4 : 3;
  const { width, height, rgba } = input;
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter none
    for (let x = 0; x < width; x += 1) {
      const s = (y * width + x) * 4;
      const d = rowStart + 1 + x * channels;
      raw[d] = rgba[s];
      raw[d + 1] = rgba[s + 1];
      raw[d + 2] = rgba[s + 2];
      if (channels === 4) raw[d + 3] = rgba[s + 3];
    }
  }
  const compressed = deflateSync(Buffer.from(raw), { level: 6 });
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const parts: Uint8Array[] = [
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(compressed)),
    chunk("IEND", new Uint8Array(0)),
  ];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export type CropRect = { x: number; y: number; width: number; height: number };

/** 从源 PNG 裁出子图并重新编码（保持源 color type；坐标为设备像素）。 */
export function cropPng(source: Uint8Array, rect: CropRect): Uint8Array | PngError {
  const decoded = decodePng(source);
  if ("reason" in decoded) return decoded;
  if (!isWholePixels(rect)) return { reason: "crop_rect_not_integer" };
  if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0) return { reason: "crop_rect_out_of_range" };
  if (rect.x + rect.width > decoded.width || rect.y + rect.height > decoded.height) return { reason: "crop_rect_out_of_range" };
  const target = new Uint8Array(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row += 1) {
    const srcStart = ((rect.y + row) * decoded.width + rect.x) * 4;
    target.set(decoded.rgba.subarray(srcStart, srcStart + rect.width * 4), row * rect.width * 4);
  }
  return encodePng({ width: rect.width, height: rect.height, rgba: target, colorType: decoded.colorType === 2 ? 2 : 6 });
}

function isWholePixels(rect: CropRect): boolean {
  return Number.isInteger(rect.x) && Number.isInteger(rect.y) && Number.isInteger(rect.width) && Number.isInteger(rect.height);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function signatureMatches(buf: Uint8Array): boolean {
  for (let i = 0; i < 8; i += 1) {
    if (buf[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

function ascii(buf: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i += 1) out += String.fromCharCode(buf[i]);
  return out;
}

function readU32(buf: Uint8Array, offset: number): number {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

function writeU32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  writeU32(out, 8 + data.length, crc32(crcInput, 0, crcInput.length));
  return out;
}
