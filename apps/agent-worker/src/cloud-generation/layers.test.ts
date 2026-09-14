import { test } from "node:test";
import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { layerPayload, parseLayerResult } from "./layers.ts";
import { configFromEnv, runGenerationWorker, sha256, type WorkerFetch } from "./runtime.ts";
import { validateLayerRequest } from "../../../cloud/supabase/functions/_shared/layer-contract.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const decompose = { operation: "decompose", size: "auto" } as const;
const edit = { operation: "edit", size: "2K" } as const;
const noNetwork: WorkerFetch = async () => { throw new Error("unexpected_network"); };
const base = { z_index: 0, b64_json: png };
const foreground = { z_index: 1, b64_json: png, name: "文字", bounding_box: { absolute: [0.1, 0.2, 0.8, 0.9] } };
const result = async (data: unknown[]) => JSON.parse(new TextDecoder().decode(await parseLayerResult({ data }, decompose, noNetwork)));

test("layer protocol omits empty prompt, fixes model and preserves alpha edit contract", () => {
  const input = { prompt: " ", reference_images: [{ mime: "image/png", base64: png }] };
  const payload = layerPayload(input, decompose);
  equal(payload.model, "doubao-seedream-5-0-pro-260628");
  equal("prompt" in payload, false);
  equal(payload.image, `data:image/png;base64,${png}`);
  equal("layer_decomposition" in payload, true);
  const changed = layerPayload({ ...input, prompt: "换成蓝色" }, edit);
  equal("background" in changed && changed.background, "transparent");
  equal(changed.output_format, "png");
  equal("layer_decomposition" in changed, false);
});

test("all layers sort by z_index and use absolute bounds without inclusive +1", async () => {
  const parsed = await result([foreground, base]);
  equal(parsed.document.layers.length, 2);
  equal(parsed.document.layers[0].background, true);
  equal(parsed.document.layers[1].x, 0.1);
  equal(parsed.document.layers[1].width, 0.8 - 0.1);
  equal(parsed.document.layers[1].dataUrl, `data:image/png;base64,${png}`);
  const normalized = await result([base, { ...foreground, bounding_box: { normalized: [100, 200, 800, 900] } }]);
  deepEqual(normalized.document.layers, parsed.document.layers);
});

test("partial, duplicate, oversized, malformed bounds and foreign download hosts fail closed", async () => {
  for (const rows of [[], [foreground], [base, base], [base, { ...foreground, bounding_box: {} }], [base, { ...foreground, bounding_box: { absolute: [0, 0, 9, 9] } }], Array.from({ length: 18 }, () => base)]) {
    await rejects(() => result(rows));
  }
  await rejects(() => result([{ z_index: 0, url: "https://127.0.0.1/private" }]));
  await rejects(() => parseLayerResult({ data: [base, foreground] }, edit, noNetwork));
});

// A container-header fixture isolates input dimension/alpha validation from image decoding.
function inputFixture() {
  const bytes = Buffer.from(png, "base64");
  bytes[18] = 2; bytes[19] = 0; bytes[22] = 2; bytes[23] = 0;
  return { schema_version: 1, media: "image", prompt: "", reference_images: [{ mime: "image/png", base64: Buffer.from(bytes).toString("base64") }], layer_options: decompose };
}

test("input validation prevents ordinary-service billing bypass and invalid layer inputs", () => {
  const input = inputFixture();
  deepEqual(validateLayerRequest(input, "image_layer_decompose"), decompose);
  throws(() => validateLayerRequest(input, "image_hd"));
  throws(() => validateLayerRequest({ ...input, layer_options: undefined }, "image_layer_decompose"));
  throws(() => validateLayerRequest({ ...input, reference_images: [] }, "image_layer_decompose"));
  throws(() => validateLayerRequest({ ...input, reference_images: [{ mime: "image/png", base64: png }] }, "image_layer_decompose"));
  throws(() => validateLayerRequest({ ...input, layer_options: edit }, "image_layer_edit"));
  equal(validateLayerRequest({ media: "image" }, "image_hd"), null);
});

test("durable worker uploads the entire bundle; malformed post-submission output stays unknown", async () => {
  for (const broken of [false, true]) {
    const input = JSON.stringify(inputFixture());
    const stop = { requested: false }; const actions: string[] = []; let bundle = "";
    const response = (value: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => typeof value === "string" ? value : JSON.stringify(value), arrayBuffer: async () => new ArrayBuffer(0) });
    const fetch: WorkerFetch = async (url, request) => {
      if (url === "https://control") {
        const body = JSON.parse(String(request?.body)); actions.push(body.action);
        if (body.action === "claim") return response({ job: { id: "j", service: "image_layer_decompose", inputManifestHash: sha256(new TextEncoder().encode(input)), inputCount: 1, attempt: 1 }, lease: { leaseId: "l", leaseSeconds: 90 }, inputUrl: "https://input" });
        if (body.action === "output_upload") { equal(body.mime, "application/json"); return response({ objectKey: "jobs/j/outputs/result.json", uploadUrl: "https://output" }); }
        if (["finish", "fail", "outcome_unknown"].includes(body.action)) stop.requested = true;
        return response({});
      }
      if (url === "https://input") return response(input);
      if (url.endsWith("/images/generations")) { const body = JSON.parse(String(request?.body)); equal(body.layer_decomposition, true); equal("stream" in body, false); return response({ data: broken ? [foreground] : [foreground, base] }); }
      if (url === "https://output") { bundle = new TextDecoder().decode(request?.body as Uint8Array); return response({}); }
      throw new Error("unexpected_url");
    };
    const config = configFromEnv({ GENERATION_CONTROL_URL: "https://control", GENERATION_WORKER_TOKEN: "token", ARK_API_KEY: "test", ARK_IMAGE_MODEL: "ordinary", GENERATION_HEARTBEAT_INTERVAL_MS: "1" });
    await runGenerationWorker(config, fetch, stop);
    equal(actions.filter(action => action === "submitted").length, 1);
    if (broken) { ok(actions.includes("outcome_unknown")); equal(actions.includes("fail"), false); }
    else { ok(actions.includes("finish")); equal(JSON.parse(bundle).document.layers.length, 2); }
  }
});
