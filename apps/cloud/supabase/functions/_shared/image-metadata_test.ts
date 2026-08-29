import { assertEquals } from "jsr:@std/assert@1";
import { imageMetadata } from "./image-metadata.ts";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

Deno.test("image metadata reads bounded PNG dimensions", () => {
  assertEquals(imageMetadata(png(1200, 800)), { mime: "image/png", width: 1200, height: 800 });
  assertEquals(imageMetadata(png(20_000, 800)), null);
  assertEquals(imageMetadata(png(0, 800)), null);
});

Deno.test("image metadata reads JPEG SOF dimensions after metadata segments", () => {
  const bytes = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc2, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x11, 0x00,
    0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
  assertEquals(imageMetadata(bytes), { mime: "image/jpeg", width: 800, height: 600 });
  assertEquals(imageMetadata(bytes.slice(0, 12)), null);
});

Deno.test("image metadata reads WebP extended and lossless dimensions", () => {
  const extended = new Uint8Array(30);
  extended.set(new TextEncoder().encode("RIFF"), 0);
  extended.set(new TextEncoder().encode("WEBPVP8X"), 8);
  extended.set([0xff, 0x01, 0x00], 24); // 512 - 1
  extended.set([0xff, 0x00, 0x00], 27); // 256 - 1
  assertEquals(imageMetadata(extended), { mime: "image/webp", width: 512, height: 256 });

  const lossless = new Uint8Array(30);
  lossless.set(new TextEncoder().encode("RIFF"), 0);
  lossless.set(new TextEncoder().encode("WEBPVP8L"), 8);
  lossless.set([0x2f, 0x3f, 0x40, 0x06, 0x00], 20); // 64 x 26
  assertEquals(imageMetadata(lossless), { mime: "image/webp", width: 64, height: 26 });
});

Deno.test("image metadata rejects signatures without a valid dimension header", () => {
  assertEquals(imageMetadata(Uint8Array.from([0xff, 0xd8, 0xff])), null);
  assertEquals(imageMetadata(new TextEncoder().encode("not an image")), null);
});
