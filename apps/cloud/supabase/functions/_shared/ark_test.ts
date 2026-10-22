import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { arkTransportError, arkUnderstandUsage, DEFAULT_IMAGE_UPSTREAM_TIMEOUT_MS, upstreamError } from "./ark.ts";

Deno.test("Ark usage keeps missing counters unknown and rejects unsafe values", () => {
  const parsed = arkUnderstandUsage({id:"unsafe\nbody",model:"model-1",usage:{
    prompt_tokens:-1,completion_tokens:"200",total_tokens:Number.MAX_SAFE_INTEGER+1,
    prompt_tokens_details:{cached_tokens:0},completion_tokens_details:{reasoning_tokens:1.5},
  }});
  assertEquals(parsed,{response_id:null,model:"model-1",provider_created:null,
    prompt_tokens:null,completion_tokens:null,total_tokens:null,cached_tokens:0,reasoning_tokens:null});
  assertEquals(arkUnderstandUsage({usage:null}).cached_tokens,null);
});

Deno.test("Ark image timeout leaves room for proxy settlement", () => {
  assertEquals(DEFAULT_IMAGE_UPSTREAM_TIMEOUT_MS, 135_000);
});

Deno.test("Ark text moderation has a distinct safe message", () => {
  const error = upstreamError(
    400,
    JSON.stringify({
      error: {
        code: "InputTextSensitiveContentDetected",
        message: "raw upstream message must not be exposed",
      },
    }),
    "request-safe-1",
  );
  assertEquals(error.status, 422);
  assertStringIncludes(error.message, "提示词未通过方舟安全审核");
  assertStringIncludes(error.message, "InputTextSensitiveContentDetected");
  assertStringIncludes(error.message, "request-safe-1");
  assertEquals(error.message.includes("raw upstream message"), false);
});

Deno.test("Ark image decode failure points to the reference image", () => {
  const error = upstreamError(
    400,
    JSON.stringify({ error: { code: "InvalidImageFormat" } }),
  );
  assertStringIncludes(error.message, "参考图无法被方舟读取");
});

Deno.test("Ark unknown validation failure stays actionable without leaking body", () => {
  const error = upstreamError(
    422,
    JSON.stringify({ error: { code: "InvalidParameter", message: "secret raw detail" } }),
  );
  assertStringIncludes(error.message, "方舟拒绝了生成参数");
  assertEquals(error.message.includes("secret raw detail"), false);
});

Deno.test("Ark AbortError is reported as timeout", () => {
  const failure = new DOMException("signal aborted", "AbortError");
  const mapped = arkTransportError(failure, 119_500, 120_000);
  assertEquals(mapped.kind, "timeout");
  assertEquals(mapped.error.code, "upstream_timeout");
  assertStringIncludes(mapped.error.message, "方舟处理超时");
});

Deno.test("Ark transport classifier keeps safe network detail", () => {
  const failure = Object.assign(new TypeError("client error"), {
    cause: new Error("connection reset by peer"),
  });
  const mapped = arkTransportError(failure, 5_000, 120_000);
  assertEquals(mapped.kind, "connection_reset");
  assertStringIncludes(mapped.error.message, "连接被重置");
});
