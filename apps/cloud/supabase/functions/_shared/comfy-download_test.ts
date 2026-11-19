import { assertComfyDownloadAccess, comfyDownloadFile, manifest, signComfyDownload } from "./comfy-download.ts";

function assert(value: unknown, message = "assertion failed"): asserts value { if (!value) throw new Error(message); }
function rejects(fn: () => unknown) { try { fn(); } catch { return; } throw new Error("expected rejection"); }

Deno.test("Comfy gate uses live paid subscription or server-side test marker", () => {
  for (const tier of ["pro", "studio"]) {
    assertComfyDownloadAccess({}, { tier, status: "active", current_period_end: "2099-01-01T00:00:00Z" });
    rejects(() => assertComfyDownloadAccess({}, { tier, status: "active", current_period_end: "2020-01-01T00:00:00Z" }));
    rejects(() => assertComfyDownloadAccess({}, { tier, status: "expired" }));
  }
  assertComfyDownloadAccess({ bowerbird_test: true }, null);
  for (const marker of [{}, { bowerbird_test: "true" }, null]) rejects(() => assertComfyDownloadAccess(marker, { tier: "free", status: "active" }));
});
Deno.test("Comfy signs only six fixed resource keys with no caller override", () => {
  assert(manifest.files.length === 6);
  assert(manifest.files.reduce((n, f) => n + f.size, 0) === 44048479273);
  for (const file of manifest.files) assert(comfyDownloadFile({ version: manifest.version, file: file.file }) === file);
  for (const file of ["../portable.7z", "portable.7z?x=1", "windows_package/package.exe", "https://evil.example/", "licenses/NOTICE.txt"]) {
    rejects(() => comfyDownloadFile({ version: manifest.version, file }));
  }
  rejects(() => comfyDownloadFile({ version: "latest", file: "portable.7z" }));
  rejects(() => comfyDownloadFile({ version: manifest.version, file: "portable.7z", tier: "pro" }));
});
Deno.test("TOS4 signature matches official Python SDK 2.9.3 fixed test vector", async () => {
  const grant = await signComfyDownload("portable.7z", "test-ak", "test-sk", new Date("2026-10-23T00:00:00Z"));
  const url = new URL(grant.url);
  assert(url.searchParams.get("X-Tos-Signature") === "697a36ec0f3065d8d58de9a7ab8134e0cce1dcaa4f3d224316897c2975f81893");
  assert(url.origin === "https://bowerbird.tos-cn-guangzhou.volces.com");
  assert(url.searchParams.get("X-Tos-Expires") === "3600");
  assert(grant.expiresAt === "2026-10-23T01:00:00.000Z");
  assert(!grant.url.includes("test-sk"));
});
