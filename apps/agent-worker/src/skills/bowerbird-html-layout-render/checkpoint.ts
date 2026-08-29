/**
 * HTML 排版 Run 的 checkpoint 编解码 —— 与 controlled-checkpoint 同款纪律（H3-T4）。
 * 身份钉死（run/conversation/skill hash）、相位一致性、render ≤1、artifact 归属校验。
 */
import { canonicalJson, sha256Hex } from "../../kernel/tool-ledger.ts";
import type { RenderHtmlResultV1 } from "../../contracts/render-html.ts";
import { validateComposeHtmlDocumentAction, validateHtmlLayoutRenderInput, type ComposeHtmlDocumentActionV1, type HtmlLayoutRenderInputV1 } from "./schemas.ts";
import type { HtmlLayoutRenderPhase } from "./phase-graph.ts";

export const HTML_LAYOUT_CHECKPOINT_SCHEMA_VERSION = 1;
const MAX_HTML_LAYOUT_CHECKPOINT_BYTES = 512 * 1024;

export type HtmlLayoutCheckpointArtifact = {
  artifactId: string;
  role: "html_document" | "render_manifest" | "viewport_screenshot" | "full_page_screenshot" | "slice_screenshot";
  index?: number;
  bytes: number;
  sha256: string;
};

export type HtmlLayoutRunnerCheckpoint = {
  schemaVersion: 1;
  runId: string;
  conversationId: string;
  skillId: "bowerbird-html-layout-render";
  skillVersion: string;
  skillHash: string;
  status: "running" | "awaiting_user_review" | "succeeded" | "cancelled";
  phase: HtmlLayoutRenderPhase;
  input: HtmlLayoutRenderInputV1;
  /** 模型已产出、副作用未完成的 compose action（崩溃恢复时按原文重放，保 argsHash 稳定）。 */
  pendingCompose: ComposeHtmlDocumentActionV1 | null;
  htmlDocument: HtmlLayoutCheckpointArtifact | null;
  renderCallCount: 0 | 1;
  renderResult: RenderHtmlResultV1 | null;
  renderManifestArtifactId: string | null;
  artifacts: HtmlLayoutCheckpointArtifact[];
};

function fail(code: string): never {
  throw new Error(code);
}

function validArtifact(value: HtmlLayoutCheckpointArtifact | null | undefined, runId: string, conversationId: string): boolean {
  return !!value && /^[A-Za-z0-9-]{1,80}$/.test(value.artifactId) && /^[0-9a-f]{64}$/.test(value.sha256) &&
    Number.isInteger(value.bytes) && value.bytes > 0 && !!runId && !!conversationId;
}

export function validateHtmlLayoutCheckpoint(checkpoint: HtmlLayoutRunnerCheckpoint): void {
  if (checkpoint.schemaVersion !== HTML_LAYOUT_CHECKPOINT_SCHEMA_VERSION) fail("html_layout_checkpoint_schema_unsupported");
  if (!checkpoint.runId || !checkpoint.conversationId || checkpoint.skillId !== "bowerbird-html-layout-render") {
    fail("html_layout_checkpoint_identity_invalid");
  }
  if (!checkpoint.skillVersion || !/^[0-9a-f]{64}$/.test(checkpoint.skillHash)) fail("html_layout_checkpoint_skill_invalid");
  validateHtmlLayoutRenderInput(checkpoint.input);
  if (checkpoint.pendingCompose) {
    if (checkpoint.htmlDocument) fail("html_layout_checkpoint_pending_compose_stale");
    try {
      validateComposeHtmlDocumentAction(
        checkpoint.pendingCompose,
        checkpoint.input.references.map((reference) => reference.artifactId),
      );
    } catch {
      fail("html_layout_checkpoint_pending_compose_invalid");
    }
  }
  if (checkpoint.renderCallCount !== 0 && checkpoint.renderCallCount !== 1) fail("html_layout_checkpoint_render_count_invalid");
  if (!validArtifact(checkpoint.htmlDocument, checkpoint.runId, checkpoint.conversationId)) {
    if (checkpoint.htmlDocument !== null || checkpoint.renderCallCount !== 0 || checkpoint.renderResult) {
      fail("html_layout_checkpoint_html_document_invalid");
    }
  }
  if (checkpoint.renderResult) {
    if (checkpoint.renderCallCount !== 1 || !checkpoint.htmlDocument) fail("html_layout_checkpoint_render_without_document");
    if (!Array.isArray(checkpoint.renderResult.outputs) || checkpoint.renderResult.outputs.length === 0) {
      fail("html_layout_checkpoint_render_outputs_invalid");
    }
  } else if (checkpoint.renderCallCount !== 0) {
    fail("html_layout_checkpoint_render_count_inconsistent");
  }
  if ((checkpoint.phase === "awaiting_user_review" || checkpoint.phase === "exporting" ||
       checkpoint.phase === "succeeded") && !checkpoint.renderResult) {
    // render_once 允许尚无结果（进入相位/崩溃恢复的中间态）；其后各相位必须有 render 结果。
    fail("html_layout_checkpoint_phase_render_missing");
  }
  if (checkpoint.status === "awaiting_user_review" && checkpoint.phase !== "awaiting_user_review") {
    fail("html_layout_checkpoint_status_phase_mismatch");
  }
  if (!Array.isArray(checkpoint.artifacts) ||
      checkpoint.artifacts.some((artifact) => !validArtifact(artifact, checkpoint.runId, checkpoint.conversationId))) {
    fail("html_layout_checkpoint_artifacts_invalid");
  }
}

export function encodeHtmlLayoutCheckpoint(checkpoint: HtmlLayoutRunnerCheckpoint): { bytes: Uint8Array; sha256: string } {
  validateHtmlLayoutCheckpoint(checkpoint);
  const bytes = new TextEncoder().encode(canonicalJson(checkpoint));
  if (bytes.byteLength > MAX_HTML_LAYOUT_CHECKPOINT_BYTES) fail("html_layout_checkpoint_too_large");
  return { bytes, sha256: sha256Hex(new TextDecoder().decode(bytes)) };
}

export function decodeHtmlLayoutCheckpoint(
  bytes: Uint8Array,
  expected: { runId: string; conversationId: string; skillVersion: string; skillHash: string; sha256: string },
): HtmlLayoutRunnerCheckpoint {
  if (!bytes.byteLength || bytes.byteLength > MAX_HTML_LAYOUT_CHECKPOINT_BYTES) fail("html_layout_checkpoint_size_invalid");
  const encoded = new TextDecoder().decode(bytes);
  if (sha256Hex(encoded) !== expected.sha256) fail("html_layout_checkpoint_object_hash_mismatch");
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    fail("html_layout_checkpoint_json_invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("html_layout_checkpoint_json_invalid");
  const checkpoint = value as HtmlLayoutRunnerCheckpoint;
  validateHtmlLayoutCheckpoint(checkpoint);
  if (checkpoint.runId !== expected.runId || checkpoint.conversationId !== expected.conversationId) {
    fail("html_layout_checkpoint_run_mismatch");
  }
  if (checkpoint.skillVersion !== expected.skillVersion || checkpoint.skillHash !== expected.skillHash) {
    fail("html_layout_checkpoint_skill_mismatch");
  }
  return checkpoint;
}
