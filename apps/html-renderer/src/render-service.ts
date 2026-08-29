/**
 * 渲染编排 —— H1-T5。一次内部请求的完整确定性管线：
 *
 *   contract validate → HTML sanitize → 资源闭集/字节复核（sha256+magic）
 *     → 临时目录（run/call 派生）→ 唯一一次 Playwright rasterization
 *     → 截图 PNG 复核（签名/CRC/尺寸/像素上限）→ capture plan（切片窗口）
 *     → 从整页 PNG 裁切 → 输出复核（尺寸/hash/总量）→ 清理
 *
 * 日志只含 requestId/时长/字节/稳定错误码，不含 HTML/资源内容。
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { RENDER_LIMITS } from "./limits.ts";
import { type InternalRenderResult, type InternalRenderSuccess, type InternalRenderOutput, validateRenderRequest, type RenderResourceMime } from "./contracts.ts";
import { renderFailure } from "./errors.ts";
import type { RenderMetrics } from "./metrics.ts";
import { sanitizeHtml } from "./sanitizer.ts";
import { computeCapturePlan } from "./slice.ts";
import { cropPng, decodePng, isPngSignature } from "./png.ts";
import { renderDocument } from "./renderer.ts";
import { declaredImageDimensions, withinResourceDimensionLimits } from "./image-dimensions.ts";
import { computeRendererFingerprint } from "./fingerprint.ts";

export type RenderLogger = (event: Record<string, unknown>) => void;

export type RenderService = {
  execute(rawRequest: unknown, requestId: string): Promise<InternalRenderResult>;
};

const MAGIC_BYTES: Record<RenderResourceMime, number[][]> = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/webp": [],
};

export function createRenderService(browser: Browser, log: RenderLogger, metrics?: RenderMetrics): RenderService {
  const chromiumVersion = browser.version();
  const rendererFingerprint = computeRendererFingerprint(chromiumVersion);
  const finish = (outcome: { ok: true } | { ok: false; code: string }, startedAt: number): void => {
    metrics?.record(outcome, Date.now() - startedAt);
  };

  return {
    async execute(rawRequest: unknown, requestId: string): Promise<InternalRenderResult> {
      const startedAt = Date.now();
      const validated = validateRenderRequest(rawRequest);
      if (!validated.ok) {
        log({ event: "render_rejected", requestId, code: validated.violation.code, reason: validated.violation.reason });
        finish({ ok: false, code: validated.violation.code }, startedAt);
        return renderFailure(validated.violation.code);
      }
      const req = validated.value;
      let requestDir: string | undefined;
      try {
        const sanitized = sanitizeHtml(req.html);
        if (!sanitized.ok) {
          log({ event: "render_rejected", requestId, code: sanitized.code, reason: sanitized.reason });
          return renderFailure(sanitized.code);
        }

        // 资源闭集与字节复核
        const resourceTable = new Map<string, { mime: RenderResourceMime; bytes: Uint8Array }>();
        for (const resource of req.resources) {
          const bytes = new Uint8Array(Buffer.from(resource.dataBase64, "base64"));
          if (bytes.length > RENDER_LIMITS.maxResourceBytes) {
            log({ event: "render_rejected", requestId, code: "render_resource_invalid", reason: "resource_too_large" });
            finish({ ok: false, code: "render_resource_invalid" }, startedAt);
            return renderFailure("render_resource_invalid");
          }
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          if (sha256 !== resource.sha256) {
            log({ event: "render_rejected", requestId, code: "render_resource_invalid", reason: "resource_sha256_mismatch" });
            finish({ ok: false, code: "render_resource_invalid" }, startedAt);
            return renderFailure("render_resource_invalid");
          }
          if (!magicMatches(resource.mime, bytes)) {
            log({ event: "render_rejected", requestId, code: "render_resource_invalid", reason: "resource_magic_mismatch" });
            finish({ ok: false, code: "render_resource_invalid" }, startedAt);
            return renderFailure("render_resource_invalid");
          }
          // H5-T1 解压炸弹防护：小文件大尺寸的图片会在 Chromium 解码时放大内存占用。
          const dims = declaredImageDimensions(bytes, resource.mime);
          if (!dims || !withinResourceDimensionLimits(dims, {
            maxSidePx: RENDER_LIMITS.maxResourceImageSidePx,
            maxPixels: RENDER_LIMITS.maxResourceImagePixels,
          })) {
            log({ event: "render_rejected", requestId, code: "render_resource_invalid", reason: "resource_dimensions_exceeded" });
            finish({ ok: false, code: "render_resource_invalid" }, startedAt);
            return renderFailure("render_resource_invalid");
          }
          resourceTable.set(resource.key, { mime: resource.mime, bytes });
        }
        for (const key of sanitized.referencedResourceKeys) {
          if (!resourceTable.has(key)) {
            log({ event: "render_rejected", requestId, code: "render_resource_invalid", reason: "referenced_resource_missing" });
            finish({ ok: false, code: "render_resource_invalid" }, startedAt);
            return renderFailure("render_resource_invalid");
          }
        }

        // 临时目录（run_id + call_id 派生；requestId/runId/callId 已过闭集 pattern，前缀防越段）
        requestDir = safeRequestDir(req);
        mkdirSync(requestDir, { recursive: true });

        const sourceHtmlSha256 = createHash("sha256").update(req.html, "utf8").digest("hex");

        // 总时限竞速：renderer 各阶段也用同一预算，race 只为按时返回稳定错误。
        const budgetMs = RENDER_LIMITS.renderTimeoutMs;
        const session = renderDocument(browser, {
          html: req.html,
          resources: resourceTable,
          referencedResourceKeys: new Set(sanitized.referencedResourceKeys),
          viewport: req.viewport,
          capture: { mode: req.capture.mode },
          background: req.background,
          timeoutMs: budgetMs,
        });
        const timer = new Promise<{ code: "render_timeout"; reason: string }>((resolve) => {
          setTimeout(() => resolve({ code: "render_timeout", reason: "render_budget_exceeded" }), budgetMs).unref?.();
        });
        const sessionResult = await Promise.race([session, timer]);
        if ("code" in sessionResult) {
          log({ event: "render_failed", requestId, code: sessionResult.code, reason: sessionResult.reason, ms: Date.now() - startedAt });
          finish({ ok: false, code: sessionResult.code }, startedAt);
          return renderFailure(sessionResult.code);
        }

        // 基础截图复核
        if (!isPngSignature(sessionResult.basePng)) {
          log({ event: "render_failed", requestId, code: "render_output_invalid", reason: "base_png_signature", ms: Date.now() - startedAt });
          return renderFailure("render_output_invalid");
        }
        const decodedBase = decodePng(sessionResult.basePng);
        if ("reason" in decodedBase) {
          log({ event: "render_failed", requestId, code: "render_output_invalid", reason: decodedBase.reason, ms: Date.now() - startedAt });
          return renderFailure("render_output_invalid");
        }

        // 以实际像素为准计算 capture plan（viewport 之外的模式即切片窗口）
        const plan = computeCapturePlan({
          mode: req.capture.mode,
          deviceScaleFactor: req.viewport.deviceScaleFactor,
          viewportWidthCssPx: req.viewport.widthCssPx,
          viewportHeightCssPx: req.viewport.heightCssPx,
          documentWidthDevicePx: decodedBase.width,
          documentHeightDevicePx: decodedBase.height,
          sliceHeightCssPx: req.capture.sliceHeightCssPx,
          overlapCssPx: req.capture.overlapCssPx,
        });
        if ("code" in plan) {
          log({ event: "render_failed", requestId, code: plan.code, reason: plan.reason, ms: Date.now() - startedAt });
          finish({ ok: false, code: plan.code }, startedAt);
          return renderFailure(plan.code);
        }

        // 产出输出：base 图 + 切片（同一像素结果裁出）
        const outputs: InternalRenderOutput[] = [];
        let totalBytes = 0;
        for (const clip of plan.clips) {
          let png: Uint8Array;
          if (clip.role === "slice_screenshot") {
            const cropped = cropPng(sessionResult.basePng, clip.rect);
            if ("reason" in cropped) {
              log({ event: "render_failed", requestId, code: "render_output_invalid", reason: cropped.reason, ms: Date.now() - startedAt });
              return renderFailure("render_output_invalid");
            }
            png = cropped;
          } else {
            // base 图 clip 应恰为整幅
            if (clip.rect.x !== 0 || clip.rect.y !== 0 || clip.rect.width !== decodedBase.width || clip.rect.height !== decodedBase.height) {
              log({ event: "render_failed", requestId, code: "render_output_invalid", reason: "base_clip_mismatch", ms: Date.now() - startedAt });
              return renderFailure("render_output_invalid");
            }
            png = sessionResult.basePng;
          }
          const decoded = decodePng(png);
          if ("reason" in decoded || decoded.width !== clip.rect.width || decoded.height !== clip.rect.height) {
            log({ event: "render_failed", requestId, code: "render_output_invalid", reason: "output_dims_mismatch", ms: Date.now() - startedAt });
            return renderFailure("render_output_invalid");
          }
          totalBytes += png.length;
          if (totalBytes > RENDER_LIMITS.maxOutputsTotalBytes) {
            log({ event: "render_failed", requestId, code: "render_document_too_large", reason: "outputs_total_bytes", ms: Date.now() - startedAt });
            return renderFailure("render_document_too_large");
          }
          outputs.push({
            role: clip.role,
            ...(clip.index !== undefined ? { index: clip.index } : {}),
            clipDevicePx: clip.rect,
            mime: "image/png",
            widthDevicePx: decoded.width,
            heightDevicePx: decoded.height,
            bytes: png.length,
            sha256: createHash("sha256").update(png).digest("hex"),
            dataBase64: Buffer.from(png).toString("base64"),
          });
        }

        const success: InternalRenderSuccess = {
          ok: true,
          schemaVersion: 1,
          rendererFingerprint,
          runId: req.runId,
          callId: req.callId,
          argsHash: req.argsHash,
          sourceHtmlSha256,
          document: {
            widthCssPx: sessionResult.documentCssWidth,
            heightCssPx: sessionResult.documentCssHeight,
            widthDevicePx: decodedBase.width,
            heightDevicePx: decodedBase.height,
          },
          renderMs: Date.now() - startedAt,
          outputs,
        };
        log({ event: "render_ok", requestId, ms: success.renderMs, outputs: outputs.length, documentDevicePx: `${decodedBase.width}x${decodedBase.height}` });
        finish({ ok: true }, startedAt);
        return success;
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 120) : "unknown";
        log({ event: "render_failed", requestId, code: "render_service_unavailable", reason, ms: Date.now() - startedAt });
        finish({ ok: false, code: "render_service_unavailable" }, startedAt);
        return renderFailure("render_service_unavailable");
      } finally {
        if (requestDir) rmSync(requestDir, { recursive: true, force: true });
      }
    },
  };
}

function magicMatches(mime: RenderResourceMime, bytes: Uint8Array): boolean {
  const magics = MAGIC_BYTES[mime];
  if (magics.length === 0) {
    // webp：RIFF....WEBP
    if (bytes.length < 12) return false;
    const riff = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
    const webp = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    return riff === "RIFF" && webp === "WEBP";
  }
  return magics.some((magic) => magic.every((byte, i) => bytes[i] === byte));
}

/** 临时目录：renderRoot/render-<runId>-<callId>；pattern 已拒绝分隔符，仍以防串段。 */
function safeRequestDir(req: { runId: string; callId: string }): string {
  const renderRoot = process.env.RENDER_TMP_DIR ?? join(tmpdir(), "bowerbird-render");
  const safe = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(renderRoot, `render-${safe(req.runId)}-${safe(req.callId)}`);
}
