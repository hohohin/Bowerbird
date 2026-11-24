import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, watch: null } });
after(() => server.close());
const { resolveNewCardImageProvider: resolve } = await server.ssrLoadModule("/src/lib/newCardImageProvider.ts");
const { modelFavoriteKey } = await server.ssrLoadModule("/src/lib/modelFavorites.ts");
const favorite = modelFavoriteKey("图像", "personal", "dreamina-web55");
const fallback = "bowerbird-cloud-image_hd";
const state = {
  defaultProvider: "jimeng", imageDefaultOrigin: null, sessionImageProvider: null,
  cloudAuth: { logged_in: true, cloud_available: true },
  cloudEntitlement: { policy: { can_use_byo: true }, balances: { daily: 0, sub: 100, topup: 0 } },
  dreaminaHealth: { ok: true }, codexHealth: { ok: true },
};
test("available pin precedes session selection and favorites", () => {
  assert.equal(resolve({ ...state, imageDefaultOrigin: "pin", sessionImageProvider: "codex" }, [favorite]), "jimeng");
});
test("manual session selection precedes favorites and an unmarked legacy default", () => {
  assert.equal(resolve({ ...state, imageDefaultOrigin: "legacy", sessionImageProvider: "codex" }, [favorite]), "codex");
});
test("first available image favorite supersedes the old default and ignores other media", () => {
  const favorites = [modelFavoriteKey("视频", "personal", "codex"), modelFavoriteKey("图像", "personal", "codex"), favorite];
  assert.equal(resolve({ ...state, imageDefaultOrigin: "legacy", codexHealth: { ok: false, reason: "未登录" } }, favorites), "dreamina-web55");
});
test("blocked pin, session selection and favorites fall through to the entitlement default", () => {
  const free = { ...state.cloudEntitlement, policy: { can_use_byo: false } };
  assert.equal(resolve({ ...state, imageDefaultOrigin: "pin", sessionImageProvider: "codex", cloudEntitlement: free }, [favorite]), fallback);
});
test("unmarked legacy preference remains usable when there is no newer selection", () => {
  assert.equal(resolve({ ...state, imageDefaultOrigin: "legacy" }, []), "jimeng");
  assert.equal(resolve(state, []), fallback);
});
