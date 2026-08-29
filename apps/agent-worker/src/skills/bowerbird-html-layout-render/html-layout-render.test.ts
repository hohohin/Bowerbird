import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_SKILL_REGISTRY } from "../builtin-skill-registry.ts";
import { loadHtmlLayoutRenderSkill } from "./loader.ts";
import { HTML_LAYOUT_RENDER_MANIFEST } from "./manifest.ts";
import { nextHtmlLayoutRenderPhase } from "./phase-graph.ts";
import { validateComposeHtmlDocumentAction, validateHtmlLayoutRenderInput } from "./schemas.ts";
import { composeHtmlDocumentWithModel } from "./model-turn.ts";
import type { ModelBackend, ModelTurnRequest, ModelTurnResult } from "../../contracts/model.ts";

const INPUT = {
  schemaVersion: 1,
  layoutPrompt: "把两张产品图排成中文长页",
  references: [
    { artifactId: "artifact-a", token: "@正面", ordinal: 1, mime: "image/png", bytes: 10, sha256: "a".repeat(64) },
    { artifactId: "artifact-b", token: "@侧面", ordinal: 2, mime: "image/jpeg", bytes: 20, sha256: "b".repeat(64) },
  ],
  viewport: { widthCssPx: 900, heightCssPx: 1200, deviceScaleFactor: 1 },
  capture: { mode: "full_page_and_slices", sliceHeightCssPx: 1200, overlapCssPx: 0 },
  background: "opaque",
} as const;

test("HTML layout Skill bundle is hash-pinned and statically registered", () => {
  const bundle = loadHtmlLayoutRenderSkill();
  equal(bundle.version, HTML_LAYOUT_RENDER_MANIFEST.version);
  ok(/^[0-9a-f]{64}$/.test(bundle.instructionHash));
  const resolved = BUILTIN_SKILL_REGISTRY.resolve(bundle.id, bundle.version);
  equal(resolved.runner, "html-layout-render");
  equal(BUILTIN_SKILL_REGISTRY.list().length, 2);
});

test("HTML layout input validator accepts only a closed explicit artifact manifest", () => {
  equal(validateHtmlLayoutRenderInput(INPUT).references.length, 2);
  throws(() => validateHtmlLayoutRenderInput({ ...INPUT, url: "https://example.com" }), /html_layout_input_invalid:shape/);
  throws(() => validateHtmlLayoutRenderInput({ ...INPUT, references: [{ ...INPUT.references[0], ordinal: 2 }] }), /html_layout_input_invalid:reference_identity/);
});

test("compose action binds asset keys to the exact Run manifest and rejects locators", () => {
  const ids = ["artifact-a", "artifact-b"];
  const valid = { schemaVersion: 1, html: '<main><img src="asset:reference-1"><img src="asset:reference-2"></main>', resourceArtifactIds: ids };
  equal(validateComposeHtmlDocumentAction(valid, ids).html, valid.html);
  throws(() => validateComposeHtmlDocumentAction({ ...valid, resourceArtifactIds: ["artifact-b", "artifact-a"] }, ids), /compose_resource_manifest/);
  throws(() => validateComposeHtmlDocumentAction({ ...valid, html: '<img src="https:\/\/example.com\/a.png">' }, ids), /compose_external_locator/);
  throws(() => validateComposeHtmlDocumentAction({ ...valid, html: '<img src="asset:reference-3">' }, ids), /compose_asset_reference/);
  throws(() => validateComposeHtmlDocumentAction({ ...valid, html: '<script>alert(1)<\/script>' }, ids), /compose_unsafe_markup/);
});

test("compose correction tells the model which closed validator rule failed", async () => {
  const requests: ModelTurnRequest[] = [];
  const model: ModelBackend = {
    id: "fake",
    async turn(request): Promise<ModelTurnResult> {
      requests.push(request);
      return {
        kind: "action",
        action: "compose_html_document",
        arguments: {
          schemaVersion: 1,
          html: requests.length === 1 ? "<main><svg></svg></main>" : "<main>安全版式</main>",
          resourceArtifactIds: [],
        },
        providerUsage: {},
      };
    },
  };
  const action = await composeHtmlDocumentWithModel({
    runId: "run-correction",
    input: validateHtmlLayoutRenderInput({
      schemaVersion: 1,
      layoutPrompt: "排版合成文案",
      references: [],
      viewport: { widthCssPx: 900, heightCssPx: 700, deviceScaleFactor: 1 },
      capture: { mode: "full_page" },
      background: "opaque",
    }),
    model,
  });
  equal(action.html, "<main>安全版式</main>");
  equal(requests.length, 2);
  ok(requests[1]!.systemPolicy.includes("html_layout_input_invalid:compose_unsafe_markup"));
});

test("compose model receives the exact artifact ids it must echo", async () => {
  let request: ModelTurnRequest | undefined;
  const model: ModelBackend = {
    id: "fake",
    async turn(value): Promise<ModelTurnResult> {
      request = value;
      return {
        kind: "action",
        action: "compose_html_document",
        arguments: {
          schemaVersion: 1,
          html: '<main><img src="asset:reference-1"><img src="asset:reference-2"></main>',
          resourceArtifactIds: ["artifact-a", "artifact-b"],
        },
        providerUsage: {},
      };
    },
  };
  await composeHtmlDocumentWithModel({ runId: "run-references", input: validateHtmlLayoutRenderInput(INPUT), model });
  const manifest = request?.context.find((block) => block.kind === "input_manifest")?.body as { references: Array<{ artifactId: string }> };
  deepEqual(manifest.references.map((reference) => reference.artifactId), ["artifact-a", "artifact-b"]);
});

test("phase graph renders once then waits only for explicit accept or discard", () => {
  equal(nextHtmlLayoutRenderPhase("prepare_inputs", "inputs_prepared"), "compose_html_document");
  equal(nextHtmlLayoutRenderPhase("compose_html_document", "html_composed"), "render_once");
  equal(nextHtmlLayoutRenderPhase("render_once", "render_completed"), "awaiting_user_review");
  throws(() => nextHtmlLayoutRenderPhase("awaiting_user_review", "render_completed"), /html_layout_phase_transition_denied/);
  equal(nextHtmlLayoutRenderPhase("awaiting_user_review", "user_accepted"), "exporting");
  equal(nextHtmlLayoutRenderPhase("awaiting_user_review", "user_discarded"), "cancelled");
  ok(HTML_LAYOUT_RENDER_MANIFEST.phases.every((phase) => !phase.allowedActions.some((action) => action.includes("vision") || action === "understand_image")));
});
