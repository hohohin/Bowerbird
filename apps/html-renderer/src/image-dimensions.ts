/**
 * 资源图片尺寸声明解析 —— H5-T1 解压炸弹防护。
 *
 * 小文件大尺寸的图片（PNG zip-bomb / 超大 JPEG / Webp）会让 Chromium 以原图
 * 尺寸分配解码内存。资源在进入浏览器前必须通过「尺寸声明上限」检查：
 * 只读头部（PNG IHDR / JPEG SOF / WebP VP8X|VP8L|VP8），不做完整解码。
 * 解析失败（无头/损坏）同样拒绝——fail closed。
 */

export type DeclaredImageDimensions = { width: number; height: number };

/** PNG：IHDR 必为首 chunk，宽高固定偏移。宽松读取（不校验 CRC/位深——只提尺寸）。 */
function pngDimensions(bytes: Uint8Array): DeclaredImageDimensions | null {
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== "IHDR") return null;
  const width = readU32(bytes, 16);
  const height = readU32(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** JPEG：扫 marker 找 SOF0–SOF15（除 DHT/JPG/DAC），段内 5/6 偏移为高/宽。 */
function jpegDimensions(bytes: Uint8Array): DeclaredImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // 无段长的 marker
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // 进入扫描数据仍未遇 SOF
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/** WebP：RIFF/WEBP + VP8X（24bit canvas-1）| VP8L（14bit）| VP8 keyframe（14bit）。 */
function webpDimensions(bytes: Uint8Array): DeclaredImageDimensions | null {
  if (bytes.length < 30) return null;
  if (String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== "RIFF" ||
      String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) !== "WEBP") return null;
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (chunk === "VP8X") {
    // bits 24..: width-1 (24bit LE)、随后 height-1 (24bit LE)
    const width = 1 + ((bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) >>> 0);
    const height = 1 + ((bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) >>> 0);
    return { width, height };
  }
  if (chunk === "VP8L") {
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (chunk === "VP8 ") {
    // keyframe header：3 个 sync byte + 2 size byte 后 14bit LE 宽/高（14bit）
    if (bytes.length < 30) return null;
    const width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
    const height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

export function declaredImageDimensions(bytes: Uint8Array, mime: "image/png" | "image/jpeg" | "image/webp"): DeclaredImageDimensions | null {
  if (mime === "image/png") return pngDimensions(bytes);
  if (mime === "image/jpeg") return jpegDimensions(bytes);
  return webpDimensions(bytes);
}

/** 上限判定：宽高每边与总像素（与 RENDER_LIMITS.maxDevicePixels 对齐的单一资源上限）。 */
export function withinResourceDimensionLimits(
  dims: DeclaredImageDimensions,
  limits: { maxSidePx: number; maxPixels: number },
): boolean {
  return dims.width <= limits.maxSidePx && dims.height <= limits.maxSidePx && dims.width * dims.height <= limits.maxPixels;
}
