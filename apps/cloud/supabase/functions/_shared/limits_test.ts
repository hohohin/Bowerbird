import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { ApiError } from "./errors.ts";
import { assertReferenceImages } from "./limits.ts";

function encoded(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

Deno.test("reference validation accepts matching JPEG bytes", () => {
  assertReferenceImages([{ mime: "image/jpeg", base64: encoded([0xff, 0xd8, 0xff, 0xd9]) }]);
});

Deno.test("reference validation rejects WebP before the billing hold", () => {
  const error = assertThrows(
    () =>
      assertReferenceImages([{
        mime: "image/webp",
        base64: encoded([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      }]),
    ApiError,
  );
  assertEquals(error.message, "参考图必须转换为 JPEG 或 PNG 后上传");
});

Deno.test("reference validation rejects MIME and byte mismatch", () => {
  const error = assertThrows(
    () =>
      assertReferenceImages([{
        mime: "image/png",
        base64: encoded([0xff, 0xd8, 0xff, 0xd9]),
      }]),
    ApiError,
  );
  assertEquals(error.message, "参考图 MIME 与真实文件格式不一致");
});
