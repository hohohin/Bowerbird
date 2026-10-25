import { test } from "node:test";
import { Buffer } from "node:buffer";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import { configFromEnv, KnownProviderError, modelForService, runGenerationWorker, type GenerationInput, type WorkerFetch } from "./runtime.ts";
import { GPT_IMAGE_MODELS, gptImageRequest } from "./gpt-image.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const input = (): GenerationInput => ({ schema_version: 1, media: "image", prompt: "private prompt", reference_images: [] });
const config = () => configFromEnv({
  GENERATION_CONTROL_URL: "https://control.test/worker", GENERATION_WORKER_TOKEN: "control-secret",
  ARK_API_KEY: "ark-secret", ARK_IMAGE_MODEL: "ark-pro", OPENAI_API_KEY: "openai-secret",
  GENERATION_HEARTBEAT_INTERVAL_MS: "1",
});

test("both GPT 2.5 services have independent fixed models and optional key", () => {
  const c = config();
  equal(c.openaiApiKey, "openai-secret");
  for (const [service, model] of Object.entries(GPT_IMAGE_MODELS)) {
    deepEqual(modelForService(c, service), { provider: "openai", model, optimizePromptMode: null });
    throws(() => modelForService({ ...c, openaiApiKey: undefined }, service), KnownProviderError);
  }
  throws(() => modelForService(c, "image_gpt25_typo"), KnownProviderError);
  equal(modelForService({ ...c, openaiApiKey: undefined }, "image_hd").model, "ark-pro");
});

test("JSON edits preserve all references and transparency; generation omits edits-only fields", () => {
  const plain = gptImageRequest(input(), GPT_IMAGE_MODELS.image_gpt25_sunburst);
  ok(plain.url.endsWith("/images/generations"));
  const body = JSON.parse(plain.body);
  equal(body.images, undefined); equal(body.n, 1); equal(body.quality, "high"); equal(body.size, "1024x1024");
  const edit = gptImageRequest({ ...input(), transparent: true, reference_images: [
    { mime: "image/png", base64: PNG }, { mime: "image/jpeg", base64: "aGVsbG8=" },
  ] }, GPT_IMAGE_MODELS.image_gpt25_flare);
  ok(edit.url.endsWith("/images/edits"));
  const edited = JSON.parse(edit.body);
  equal(edited.background, "transparent"); equal(edited.output_format, "png");
  deepEqual(edited.images, [{ image_url: `data:image/png;base64,${PNG}` }, { image_url: "data:image/jpeg;base64,aGVsbG8=" }]);
  for (const forbidden of ["image", "watermark", "response_format", "optimize_prompt_options", "input_fidelity"]) {
    equal(edited[forbidden], undefined);
  }
});

test("seven desktop ratios retain exact aspect ratios and legal 16-pixel dimensions", () => {
  for (const ratio of ["1:1", "3:4", "4:3", "2:3", "3:2", "16:9", "9:16"]) {
    const { size } = JSON.parse(gptImageRequest({ ...input(), ratio }, GPT_IMAGE_MODELS.image_gpt25_flare).body);
    const [w, h] = size.split("x").map(Number); const [rw, rh] = ratio.split(":").map(Number);
    equal(w % 16, 0); equal(h % 16, 0); equal(w * rh, h * rw); ok(w * h <= 1536 * 1024);
  }
  throws(() => gptImageRequest({ ...input(), ratio: "20:1" }, GPT_IMAGE_MODELS.image_gpt25_flare), KnownProviderError);
});

async function runCase(options: {
  service?: string; missingKey?: boolean; mock?: boolean; status?: number; result?: unknown;
  transportError?: boolean; uploadError?: boolean; ratio?: string; references?: boolean;
} = {}) {
  const source = input(); source.ratio = options.ratio;
  if (options.references) source.reference_images = [{ mime: "image/png", base64: PNG }];
  const sourceText = JSON.stringify(source);
  const c = config(); if (options.missingKey) c.openaiApiKey = undefined; c.mock = options.mock ?? false;
  const stop = { requested: false };
  const actions: Record<string, unknown>[] = [];
  const upstream: Array<{ url: string; body: Record<string, unknown>; key?: string }> = [];
  let uploads = 0;
  const response = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status, headers: { get: () => null },
    text: async () => typeof body === "string" ? body : JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0),
  });
  const fetch: WorkerFetch = async (url, request) => {
    if (url === c.controlUrl) {
      equal(request?.headers?.authorization, "Bearer control-secret");
      const body = JSON.parse(String(request?.body)); actions.push(body);
      if (body.action === "claim") {
        stop.requested = true;
        return response({ job: { id: "job", service: options.service ?? "image_gpt25_sunburst",
          inputManifestHash: createHash("sha256").update(sourceText).digest("hex"), inputCount: source.reference_images.length, attempt: 1 },
          lease: { leaseId: "lease", leaseSeconds: 90 }, inputUrl: "https://storage.test/input" });
      }
      if (body.action === "output_upload") return response({ uploadUrl: "https://storage.test/output", objectKey: "jobs/job/output.png" });
      return response({});
    }
    if (url === "https://storage.test/input") return response(sourceText);
    if (url === "https://storage.test/output") {
      equal(request?.headers?.authorization, undefined); uploads++;
      deepEqual(Buffer.from(request!.body as Uint8Array), Buffer.from(PNG, "base64"));
      return response({}, options.uploadError ? 500 : 200);
    }
    ok(url.startsWith("https://api.openai.com/v1/") || url.startsWith(c.arkBaseUrl));
    ok(actions.some(a => a.action === "submitted"));
    upstream.push({ url, body: JSON.parse(String(request?.body)), key: request?.headers?.authorization });
    if (options.transportError) throw new Error("private network details");
    return response(options.result ?? { data: [{ b64_json: PNG }] }, options.status ?? 200);
  };
  await runGenerationWorker(c, fetch, stop);
  return { actions, upstream, uploads };
}

test("both models run through durable submit, PNG upload and single settlement", async () => {
  for (const [service, model] of Object.entries(GPT_IMAGE_MODELS)) {
    for (const references of [false, true]) {
      const f = await runCase({ service, references });
      equal(f.upstream.length, 1); equal(f.upstream[0].body.model, model);
      equal(f.upstream[0].key, "Bearer openai-secret");
      equal(f.upstream[0].url, `https://api.openai.com/v1/images/${references ? "edits" : "generations"}`);
      deepEqual(f.actions.map(a => a.action), ["claim", "submitted", "output_upload", "finish"]);
      equal(f.uploads, 1); equal(f.actions.at(-1)?.sha256, createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex"));
    }
  }
});

test("missing key, invalid ratios and unknown GPT services fail before submission", async () => {
  for (const options of [{ missingKey: true }, { ratio: "10:1" }, { service: "image_gpt25_unknown" }]) {
    const f = await runCase(options); equal(f.upstream.length, 0);
    deepEqual(f.actions.map(a => a.action), ["claim", "fail"]);
  }
});

test("uncertain provider and upload outcomes never resubmit or refund", async () => {
  for (const options of [{ transportError: true }, { status: 408 }, { status: 500 }, { status: 504 },
    { result: {} }, { result: { data: [{ b64_json: "aGVsbG8=" }] } },
    { result: { data: [{ url: "https://untrusted.test/result" }] } }, { uploadError: true }]) {
    const f = await runCase(options); equal(f.upstream.length, 1);
    equal(f.actions.at(-1)?.action, "outcome_unknown");
    ok(!f.actions.some(a => a.action === "fail" || a.action === "finish"));
    ok(!JSON.stringify(f.actions).includes("private"));
    ok(!JSON.stringify(f.actions).includes("openai-secret"));
  }
});

test("explicit rejections fail once with safe messages, without exposing provider body", async () => {
  for (const status of [400, 401, 403, 404, 413, 422, 429]) {
    const f = await runCase({ status, result: { error: { code: "moderation_blocked", message: "private prompt and key" } } });
    equal(f.upstream.length, 1); equal(f.actions.at(-1)?.action, "fail"); equal(f.uploads, 0);
    ok(!JSON.stringify(f.actions).includes("private"));
    if (status === 400) equal(f.actions.at(-1)?.safeErrorCode, "content_moderation");
  }
});

test("mock mode makes no provider call, and existing Ark tier retains its key and model", async () => {
  const mock = await runCase({ mock: true, missingKey: true });
  equal(mock.upstream.length, 0); equal(mock.actions.at(-1)?.action, "finish");
  const ark = await runCase({ service: "image_hd", missingKey: true });
  equal(ark.upstream.length, 1); equal(ark.upstream[0].key, "Bearer ark-secret");
  equal(ark.upstream[0].body.model, "ark-pro"); equal(ark.actions.at(-1)?.action, "finish");
});
