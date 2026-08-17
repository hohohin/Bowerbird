import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { test } from "node:test";

import { configFromEnv, mapArkHttpError, modelForService, KnownProviderError } from "./runtime.ts";

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
