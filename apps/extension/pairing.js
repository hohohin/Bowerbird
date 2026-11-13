"use strict";

// Private signing material is available only to trusted extension contexts.
// The desktop stores only the public half, copied from the options page.
const BowerbirdPairing = (() => {
  const protocol = "bowerbird-v2";
  const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
  async function load() {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    return (await chrome.storage.local.get("collectionKey")).collectionKey;
  }
  async function generate() {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const key = {
      publicKey: hex(await crypto.subtle.exportKey("raw", pair.publicKey)),
      privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
    };
    await chrome.storage.local.set({ collectionKey: key });
    return key;
  }
  async function proof(origin, scope) {
    const key = await load();
    if (!key) return { ok: false, code: "pair_required" };
    let session;
    try {
      const response = await fetch("http://127.0.0.1:39871/pairing-session", {
        cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(3000),
      });
      session = response.headers.get("x-bowerbird-session");
      if (response.status !== 204 || !/^[0-9a-f]{32}$/.test(session)) return { ok: false, code: "desktop_upgrade" };
    } catch { return { ok: false, code: "desktop_unavailable" }; }
    const time = Math.floor(Date.now()/1000);
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const signing = await crypto.subtle.importKey("jwk", key.privateKey, "Ed25519", false, ["sign"]);
    const bytes = new TextEncoder().encode([protocol, session, scope, origin, time, nonce].join("\n"));
    const signature = hex(await crypto.subtle.sign("Ed25519", signing, bytes));
    return { ok: true, protocols: [protocol, `bb.${time}.${nonce}.${signature}`] };
  }
  return { load, generate, proof };
})();
