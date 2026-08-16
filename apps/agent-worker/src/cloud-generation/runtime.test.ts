import { equal, ok } from "node:assert/strict";
import { test } from "node:test";

import { configFromEnv, mapArkHttpError } from "./runtime.ts";

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
