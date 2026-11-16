// Only loaded via NODE_OPTIONS in the isolated authorization smoke.
const fixture = new URL(process.env.BOWERBIRD_DSH_ACCOUNT_FIXTURE);
if (fixture.protocol !== "http:" || fixture.hostname !== "127.0.0.1") throw Error("Expected loopback fixture");
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (["https://platform.deepseek.com", "https://api.deepseek.com"].includes(url.origin)) {
    const target = new URL(url.pathname + url.search, fixture);
    return original(target, { method: request.method, headers: request.headers,
      body: request.body ? await request.arrayBuffer() : undefined, signal: request.signal, redirect: "error" });
  }
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return original(request);
  throw Error("External network disabled in DSH authorization fixture");
};
