/**
 * HTML 排版 Skill 的模型 compose 回合 —— H3-T3/T4。
 *
 * 模型在 `compose_html_document` phase 只允许返回一个 action：compose_html_document。
 * 回合结束即做确定性闭集校验（validateComposeHtmlDocumentAction：资源 manifest 同序、
 * asset:reference-N 闭集、外部定位符/危险标记拒绝）；不通过 → 一次纠正重试 → 仍失败则
 * 本 Run 安全失败（没有自动修订循环，§6.3）。
 */
import { sha256Hex } from "../../kernel/tool-ledger.ts";
import { lookupTool } from "../../kernel/policy-engine.ts";
import type { AbortSignalLike, ContextBlock, ModelBackend } from "../../contracts/model.ts";
import { loadHtmlLayoutRenderSkill } from "./loader.ts";
import {
  validateComposeHtmlDocumentAction,
  type ComposeHtmlDocumentActionV1,
  type HtmlLayoutRenderInputV1,
} from "./schemas.ts";

function contextBlock(kind: ContextBlock["kind"], source: string, body: unknown): ContextBlock {
  return { kind, source, trust: "system", body, contentHash: sha256Hex(JSON.stringify(body)) };
}

const SYSTEM_POLICY = [
  "Produce exactly one compose_html_document action for this run.",
  "Images must use src=\"asset:reference-N\" where N is the 1-based input order; resourceArtifactIds must repeat the input manifest order exactly.",
  "The document must be self-contained: inline <style> only, system font stack, no URL, path, JavaScript, event attributes, iframe, form, SVG, webfont, CSS import, or data URI.",
  "Use only html, head, meta, title, style, body, div, span, p, h1-h6, ul, ol, li, dl, dt, dd, table sections/cells, section, article, header, footer, main, nav, aside, figure, figcaption, blockquote, pre, code, text emphasis, img, br, and hr tags.",
  "HTML attributes are a closed set: class, id, style, and lang globally; meta may only have charset=\"utf-8\"; img may use src, width, height, and alt; table cells may use colspan and rowspan; ol may use start. Never emit viewport meta name/content, ARIA, data-*, role, or any other attribute.",
  "Do not emit HTML or CSS comments. CSS must not contain backslash escapes, @font-face, @keyframes, animation, transition, filter, or any at-rule except @media and @supports.",
  "Preserve the user's wording; adjust hierarchy, spacing, columns and font sizes for layout only; do not invent facts.",
  "This run has no revision loop: if the validator rejects, you get one corrective attempt, then the run fails.",
].join(" ");

export async function composeHtmlDocumentWithModel(args: {
  runId: string;
  input: HtmlLayoutRenderInputV1;
  model: ModelBackend;
  signal?: AbortSignalLike;
}): Promise<ComposeHtmlDocumentActionV1> {
  const skill = loadHtmlLayoutRenderSkill();
  const composeTool = lookupTool("compose_html_document");
  if (!composeTool) throw new Error("html_layout_compose_tool_missing");

  const expectedResourceIds = args.input.references.map((reference) => reference.artifactId);
  const context: ContextBlock[] = [
    contextBlock("user_goal", "kernel", { layoutPrompt: args.input.layoutPrompt }),
    contextBlock("input_manifest", "kernel", {
      references: args.input.references.map((reference) => ({
        artifactId: reference.artifactId,
        token: reference.token,
        ordinal: reference.ordinal,
        mime: reference.mime,
        assetKey: `asset:reference-${reference.ordinal}`,
      })),
    }),
    contextBlock("phase_brief", "kernel", {
      viewport: args.input.viewport,
      capture: args.input.capture,
      background: args.input.background,
      rules: "Write the full HTML document now; it will be rendered offline exactly once.",
    }),
  ];

  let correctionReason = "unknown";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await args.model.turn(
      {
        runId: args.runId,
        phase: "compose_html_document",
        systemPolicy: attempt === 0
          ? SYSTEM_POLICY
          : `${SYSTEM_POLICY} The previous submission failed deterministic validation (${correctionReason}). Return one corrected compose_html_document action only.`,
        skillInstructions: `${skill.instructions}\n\n---\n${skill.layoutRules}`,
        context,
        allowedActions: [composeTool],
        responseSchemaVersion: 1,
      },
      args.signal ?? { aborted: false },
    );
    if (result.kind === "action" && result.action === "compose_html_document") {
      try {
        return validateComposeHtmlDocumentAction(result.arguments, expectedResourceIds);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        correctionReason = /^html_layout_input_invalid:[a-z_]+$/.test(message) ? message : "unknown";
        continue; // 纠正重试
      }
    }
    // message / refusal / 非 compose action：一次纠正机会后 fail closed。
  }
  throw new Error("html_layout_compose_failed");
}
