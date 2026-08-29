export type ImageMetadata = {
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
};

const MAX_DIMENSION = 16_384;

function validDimensions(width: number, height: number): { width: number; height: number } | null {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
      width >= 1 && width <= MAX_DIMENSION && height >= 1 && height <= MAX_DIMENSION
    ? { width, height }
    : null;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47 ||
      bytes[4] !== 0x0d || bytes[5] !== 0x0a || bytes[6] !== 0x1a || bytes[7] !== 0x0a ||
      bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const width = ((bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!) >>> 0;
  const height = ((bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!) >>> 0;
  return validDimensions(width, height);
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (frameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      return validDimensions(
        (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
      );
    }
    offset += segmentLength;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30 || bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46 ||
      bytes[8] !== 0x57 || bytes[9] !== 0x45 || bytes[10] !== 0x42 || bytes[11] !== 0x50) return null;
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (chunk === "VP8X") {
    return validDimensions(
      1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16),
      1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16),
    );
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    return validDimensions(
      1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8),
      1 + ((bytes[22]! & 0xc0) >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10),
    );
  }
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return validDimensions(
      (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
      (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
    );
  }
  return null;
}

/** Reads only trusted container headers; malformed/truncated/oversized images fail closed. */
export function imageMetadata(bytes: Uint8Array): ImageMetadata | null {
  const png = pngDimensions(bytes);
  if (png) return { mime: "image/png", ...png };
  const jpeg = jpegDimensions(bytes);
  if (jpeg) return { mime: "image/jpeg", ...jpeg };
  const webp = webpDimensions(bytes);
  return webp ? { mime: "image/webp", ...webp } : null;
}
