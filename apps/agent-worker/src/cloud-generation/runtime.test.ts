import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { test } from "node:test";

import { configFromEnv, mapArkHttpError, modelForService, arkImageRequestBody, KnownProviderError } from "./runtime.ts";

test("Seedream 5.5 is isolated from Pro/Fast and sends PNG for transparent text and image inputs", () => {
  const env = { GENERATION_CONTROL_URL: "https://control", GENERATION_WORKER_TOKEN: "token",
    ARK_API_KEY: "test", ARK_IMAGE_MODEL: "pro", ARK_IMAGE_MODEL_55: "doubao-seedream-5-5-261028" };
  const config = configFromEnv(env);
  for (const service of ["image_seedream55", "image_seedream55_1k", "image_seedream55_15k"]) {
    const choice = modelForService(config, service);
    equal(choice.model, env.ARK_IMAGE_MODEL_55);
    equal(choice.optimizePromptMode, null);
    for (const reference_images of [[], [{ mime: "image/png" as const, base64: "test" }]]) {
      const body = arkImageRequestBody({ schema_version: 1, media: "image", prompt: "sticker",
        reference_images, transparent: true, billing: { output_size: "1.5K" } }, choice, config);
      equal(body.output_format, "png");
      equal(body.background, "transparent");
      equal(body.size, "1.5K");
      equal(body.optimize_prompt_options, undefined);
    }
    throws(() => modelForService(configFromEnv({ ...env, ARK_IMAGE_MODEL_55: "" }), service),
      (error: unknown) => error instanceof KnownProviderError && error.safeCode === "model_not_configured");
  }
  equal(modelForService(config, "image_hd").model, "pro");
  equal(modelForService(config, "image_fast").optimizePromptMode, "fast");
});

test("accepted Bcoin size overrides the worker default, legacy input retains its default", () => {
  const input = { schema_version: 1, media: "image" as const, prompt: "test", reference_images: [] };
  const choice = { model: "pro", optimizePromptMode: null };
  equal(arkImageRequestBody(input, choice, { arkImageSize: "2K" }).size, "2K");
  equal(arkImageRequestBody({ ...input, billing: { output_size: "1K" } }, choice, { arkImageSize: "2K" }).size, "1K");
});

test("config requires dedicated control credentials", () => {
  const config = configFromEnv({
    GENERATION_CONTROL_URL: "https://example.supabase.co/functions/v1/generation-worker",
    GENERATION_WORKER_TOKEN: "token",
    GENERATION_WORKER_ID: "worker-1",
    ARK_API_KEY: "ark-key",
    ARK_IMAGE_MODEL: "seedream-model",
  });
  equal(config.workerId, "worker-1");
  equal(config.heartbeatIntervalMs, 30_000);
  equal(config.mock, false);
});

test("config reads optional tiered image models", () => {
  const config = configFromEnv({
    GENERATION_CONTROL_URL: "https://example.supabase.co/functions/v1/generation-worker",
    GENERATION_WORKER_TOKEN: "token",
    ARK_API_KEY: "ark-key",
    ARK_IMAGE_MODEL: "doubao-seedream-5-0-pro-260628",
    ARK_IMAGE_MODEL_LITE: "doubao-seedream-5-0-260128",
  });
  equal(config.arkImageModelLite, "doubao-seedream-5-0-260128");
});

test("modelForService routes job service to the tiered model", () => {
  const config = configFromEnv({
    GENERATION_CONTROL_URL: "https://example.supabase.co/functions/v1/generation-worker",
    GENERATION_WORKER_TOKEN: "token",
    ARK_API_KEY: "ark-key",
    ARK_IMAGE_MODEL: "pro-model",
    ARK_IMAGE_MODEL_LITE: "lite-model",
  });
  deepEqual(modelForService(config, "image_hd"), { model: "pro-model", optimizePromptMode: null });
  // Lite 与遗留 image_sd（旧构建仍在发）同走 Lite 模型（官方 Lite 即标准版）。
  deepEqual(modelForService(config, "image_lite"), { model: "lite-model", optimizePromptMode: null });
  deepEqual(modelForService(config, "image_sd"), { model: "lite-model", optimizePromptMode: null });
  // fast 档 = Pro 模型 + optimize_prompt_options.mode=fast。
  deepEqual(modelForService(config, "image_fast"), { model: "pro-model", optimizePromptMode: "fast" });
  deepEqual(modelForService(config, "anything-else"), { model: "pro-model", optimizePromptMode: null });
});

test("modelForService fails cleanly when a tier is not configured", () => {
  const config = configFromEnv({
    GENERATION_CONTROL_URL: "https://example.supabase.co/functions/v1/generation-worker",
    GENERATION_WORKER_TOKEN: "token",
    ARK_API_KEY: "ark-key",
    ARK_IMAGE_MODEL: "pro-model",
  });
  deepEqual(modelForService(config, "image_hd"), { model: "pro-model", optimizePromptMode: null });
  deepEqual(modelForService(config, "image_fast"), { model: "pro-model", optimizePromptMode: "fast" });
  const assertNotConfigured = (service: string) => {
    throws(
      () => modelForService(config, service),
      (error: unknown) => error instanceof KnownProviderError && error.safeCode === "model_not_configured",
    );
  };
  assertNotConfigured("image_lite");
  assertNotConfigured("image_sd");
});

test("Ark moderation errors retain only safe identifiers", () => {
  const error = mapArkHttpError(400, JSON.stringify({
    error: { code: "InputTextSensitiveContentDetected", request_id: "req-safe-1", message: "private upstream text" },
  }));
  equal(error.safeCode, "content_moderation");
  ok(error.safeMessage.includes("提示词未通过方舟安全审核"));
  ok(!error.safeMessage.includes("private upstream text"));
});

test("Ark invalid image error explains the actionable cause", () => {
  const error = mapArkHttpError(422, JSON.stringify({ code: "InvalidImageFormat" }), "req-2");
  equal(error.safeCode, "invalid_reference_image");
  ok(error.safeMessage.includes("格式、尺寸与宽高比"));
  ok(error.safeMessage.includes("req-2"));
});

test("arkImageRequestBody maps transparent input to background: transparent", () => {
  const config = { arkImageSize: "2K" };
  const base = { schema_version: 1, media: "image" as const, prompt: "一只猫", reference_images: [] };
  const plain = arkImageRequestBody({ ...base }, { model: "pro-model", optimizePromptMode: null }, config);
  equal(plain.background, undefined);
  const transparent = arkImageRequestBody(
    { ...base, transparent: true },
    { model: "pro-model", optimizePromptMode: "fast" },
    config,
  );
  equal(transparent.background, "transparent");
  deepEqual(transparent.optimize_prompt_options, { mode: "fast" });
});
