import { test } from "node:test";
import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { layerPayload, parseLayerResult } from "./layers.ts";
import { configFromEnv, runGenerationWorker, sha256, type WorkerFetch } from "./runtime.ts";
import { validateLayerRequest } from "../../../cloud/supabase/functions/_shared/layer-contract.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const decompose = { operation: "decompose", size: "auto" } as const;
const extended = { ...decompose, max_images: 100, text_recognition: true };
const edit = { operation: "edit", size: "2K" } as const;
const generate = { operation: "generate", size: "auto" } as const;
const noNetwork: WorkerFetch = async () => { throw new Error("unexpected_network"); };
const base = { z_index: 0, b64_json: png };
const foreground = { z_index: 1, b64_json: png, name: "文字", bounding_box: { absolute: [0.1, 0.2, 0.8, 0.9] } };
const result = async (data: unknown[]) => JSON.parse(new TextDecoder().decode(await parseLayerResult({ data }, decompose, noNetwork)));

test("layer protocol fixes 5.5, omits empty prompt and protects legacy 17-image clients", () => {
  const input = { prompt: " ", reference_images: [{ mime: "image/png", base64: png }] };
  const payload = layerPayload(input, decompose);
  equal(payload.model, "doubao-seedream-5-5-261028");
  equal("prompt" in payload, false);
  equal(payload.image, `data:image/png;base64,${png}`);
  equal(payload.response_format, "url");
  deepEqual(payload.layer_decomposition_options, { max_images: 17, text_recognition: false });
  deepEqual(layerPayload(input, extended).layer_decomposition_options, { max_images: 100, text_recognition: true });
  deepEqual(layerPayload(input, { ...decompose, text_recognition: false }).layer_decomposition_options,
    { max_images: 30, text_recognition: false });
  const changed = layerPayload({ ...input, prompt: "换成蓝色" }, edit);
  equal("background" in changed && changed.background, "transparent");
  equal(changed.output_format, "png");
  equal("layer_decomposition" in changed, false);
  const withContext = layerPayload({ ...input, prompt: "保留选中元素", reference_images: [...input.reference_images, ...input.reference_images] }, edit);
  deepEqual(withContext.image, [payload.image, payload.image]);
  ok(String(withContext.prompt).includes("图1是本次要修改的图层"));
  ok(String(withContext.prompt).endsWith("保留选中元素"));
  const newLayer = layerPayload({ prompt: "生成贴纸", reference_images: [] }, generate);
  equal("image" in newLayer, false);
  equal(newLayer.background, "transparent");
  equal(newLayer.size, "2K");
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

test("99 foreground layers plus the base are accepted at the request limit", async () => {
  const data = [base, ...Array.from({ length: 99 }, (_, index) => ({ ...foreground, z_index: index + 1 }))].reverse();
  const document = JSON.parse(new TextDecoder().decode(await parseLayerResult({ data }, extended, noNetwork))).document;
  equal(document.layers.length, 100);
  equal(document.layers[99].id, "layer-99");
  await rejects(() => parseLayerResult({ data }, { ...extended, max_images: 99 }, noNetwork), /layer_response_invalid/);
  await rejects(() => parseLayerResult({ data: [...data, { ...foreground, z_index: 100 }] }, extended, noNetwork));
  const sparse = [base, { ...foreground, z_index: 99 }];
  const sparseResult = await parseLayerResult({ data: sparse, usage: { generated_images: 2 } }, extended, noNetwork);
  equal(JSON.parse(new TextDecoder().decode(sparseResult)).document.layers[1].id, "layer-99");
  await rejects(() => parseLayerResult({ data: sparse, usage: { generated_images: 3 } }, extended, noNetwork), /layer_response_invalid/);
  await rejects(() => parseLayerResult({ data: [base, { ...foreground, z_index: 100 }] }, extended, noNetwork), /layer_order_invalid/);
  await rejects(() => parseLayerResult({ data: [base, { ...foreground, error: { code: "missing_image" } }] }, extended, noNetwork), /layer_order_invalid/);
});

test("validated Ark rich-text metadata survives and malformed or disabled OCR keeps the bitmap", async () => {
  const style = { similar_font_family: "Arial", foreground_color: "#112233", bold: true, italic: true,
    underline: true, strikethrough: true, shadow: true, translucent: false };
  const richText = { text: "标题", lines: [{ bounding_box: { absolute: [0, 0, 1, 1], normalized: [100, 200, 800, 900] },
    runs: [{ text: "标", style }, { text: "题", style: { ...style, similar_font_family: "unknown", shadow: false } }] }] };
  const first = { ...foreground, text_recognition: richText };
  const other = { ...foreground, z_index: 2, text_recognition: { ...richText, lines: [{
    bounding_box: { absolute: [0, 0, 2, 2] }, runs: richText.lines[0]!.runs,
  }] } };
  const data = [{ ...base, text_recognition: richText }, first, other, { ...foreground, z_index: 3 }];
  const parsed = JSON.parse(new TextDecoder().decode(await parseLayerResult({ data }, extended, noNetwork))).document.layers;
  equal(parsed[0].textRecognition, undefined);
  deepEqual(parsed[1].textRecognition, richText);
  equal(parsed[2].textRecognition, undefined);
  equal(parsed[3].textRecognition, undefined);
  equal(parsed[2].dataUrl, parsed[1].dataUrl);
  const legacy = await result(data);
  equal(legacy.document.layers[1].textRecognition, undefined);
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
  for (const max_images of [1, 101, 2.5, "20", null]) {
    throws(() => validateLayerRequest({ ...input, layer_options: { ...decompose, max_images } }, "image_layer_decompose"));
  }
  throws(() => validateLayerRequest({ ...input, layer_options: { ...decompose, text_recognition: "false" } }, "image_layer_decompose"));
  deepEqual(validateLayerRequest({ ...input, layer_options: extended }, "image_layer_decompose"), extended);
  const bytes = Buffer.from(input.reference_images[0]!.base64, "base64");
  bytes[25] = 2; // RGB PNG without an alpha channel
  const reference = { mime: "image/png", base64: bytes.toString("base64") };
  const layerEdit = { ...input, prompt: "修改图层", layer_options: edit, reference_images: Array(10).fill(reference) };
  deepEqual(validateLayerRequest(layerEdit, "image_layer_edit"), edit);
  throws(() => validateLayerRequest({ ...layerEdit, reference_images: Array(11).fill(reference) }, "image_layer_edit"));
  const layerGenerate = { ...input, prompt: "生成图层", layer_options: generate, reference_images: [] };
  deepEqual(validateLayerRequest(layerGenerate, "image_layer_edit"), generate);
  throws(() => validateLayerRequest({ ...layerGenerate, reference_images: [reference] }, "image_layer_edit"));
  throws(() => validateLayerRequest(layerGenerate, "image_layer_decompose"));
});

test("durable worker uploads the entire bundle; malformed post-submission output stays unknown", async () => {
  for (const broken of [false, true]) {
    const input = JSON.stringify(inputFixture());
    const providerUrl = "https://arkdocs.tos-cn-beijing.volces.com/images/layer.png";
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
      if (url.endsWith("/images/generations")) {
        const body = JSON.parse(String(request?.body));
        equal(body.layer_decomposition, true);
        equal(body.response_format, "url");
        equal("stream" in body, false);
        return response({ data: broken ? [foreground] : [{ ...foreground, b64_json: undefined, url: providerUrl }, base] });
      }
      if (url === providerUrl) {
        equal(request?.method, "GET");
        equal(request?.redirect, "error");
        equal(request?.signal?.aborted, false);
        let read = false;
        return { ...response(""), body: { getReader: () => ({
          read: async () => {
            if (read) return { done: true };
            read = true;
            return { done: false, value: Buffer.from(png, "base64") };
          },
          cancel: async () => {},
        }) } };
      }
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

test("layer downloads retry a transient stream loss, abort the failed attempt and do not retry 404", async () => {
  const data = [base, { ...foreground, b64_json: undefined, url: "https://arkdocs.tos-cn-beijing.volces.com/layer.png" }];
  const signals: AbortSignal[] = [];
  const response = (status: number) => ({ ok: status === 200, status, headers: { get: () => null },
    text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) });
  const cancelled: number[] = [];
  const transient: WorkerFetch = async (_url, request) => {
    const attempt = signals.length;
    if (attempt > 0) equal(signals[attempt - 1]!.aborted, true);
    signals.push(request!.signal!);
    let read = false;
    return { ...response(200), body: { getReader: () => ({
      read: async () => {
        if (attempt === 0) throw new Error("closed provider stream");
        if (read) return { done: true };
        read = true;
        return { done: false, value: Buffer.from(png, "base64") };
      },
      cancel: async () => { cancelled.push(attempt); },
    }) } };
  };
  const parsed = JSON.parse(new TextDecoder().decode(await parseLayerResult({ data }, extended, transient)));
  equal(parsed.document.layers[1].dataUrl, `data:image/png;base64,${png}`);
  equal(signals.length, 2);
  deepEqual(cancelled, [0, 1]);
  let definitiveAttempts = 0;
  await rejects(() => parseLayerResult({ data }, extended, async () => {
    definitiveAttempts++;
    return response(404);
  }), /layer_download_failed/);
  equal(definitiveAttempts, 1);
});

test("durable 5.5 worker accepts opaque/context references or no input and ships only RGBA output", async () => {
  const original = inputFixture().reference_images[0]!;
  const opaque = Buffer.from(original.base64, "base64");
  opaque[25] = 2;
  const references = [{ ...original, base64: opaque.toString("base64") }, original];
  for (const options of [edit, generate]) {
    const reference_images = options.operation === "edit" ? references : [];
    const input = JSON.stringify({ ...inputFixture(), prompt: "绘制透明贴纸", layer_options: options, reference_images });
    const stop = { requested: false };
    const response = (value: unknown) => ({ ok: true, status: 200, headers: { get: () => null },
      text: async () => typeof value === "string" ? value : JSON.stringify(value), arrayBuffer: async () => new ArrayBuffer(0) });
    let finishAction = "";
    const mockFetch: WorkerFetch = async (url, request) => {
      if (url === "https://control") {
        const body = JSON.parse(String(request?.body));
        if (body.action === "claim") return response({
          job: { id: "j", service: "image_layer_edit", inputManifestHash: sha256(new TextEncoder().encode(input)), inputCount: reference_images.length, attempt: 1 },
          lease: { leaseId: "l", leaseSeconds: 90 }, inputUrl: "https://input",
        });
        if (body.action === "output_upload") return response({ objectKey: "jobs/j/outputs/result.json", uploadUrl: "https://output" });
        if (["finish", "outcome_unknown", "fail"].includes(body.action)) { finishAction = body.action; stop.requested = true; }
        return response({});
      }
      if (url === "https://input") return response(input);
      if (url.endsWith("/images/generations")) {
        const body = JSON.parse(String(request?.body));
        equal(body.model, "doubao-seedream-5-5-261028");
        equal(body.background, "transparent");
        equal(body.output_format, "png");
        equal(body.size, "2K");
        deepEqual(body.image, reference_images.length ? reference_images.map(image => `data:${image.mime};base64,${image.base64}`) : undefined);
        return response({ data: [base] });
      }
      if (url === "https://output") {
        deepEqual(JSON.parse(new TextDecoder().decode(request?.body as Uint8Array)), { image: `data:image/png;base64,${png}` });
        return response({});
      }
      throw new Error("unexpected_url");
    };
    const config = configFromEnv({ GENERATION_CONTROL_URL: "https://control", GENERATION_WORKER_TOKEN: "token",
      ARK_API_KEY: "test", ARK_IMAGE_MODEL: "ordinary", GENERATION_HEARTBEAT_INTERVAL_MS: "1" });
    await runGenerationWorker(config, mockFetch, stop);
    equal(finishAction, "finish");
  }
  await rejects(() => parseLayerResult({ data: [{ b64_json: opaque.toString("base64") }] }, generate, noNetwork), /layer_edit_alpha_missing/);
});
