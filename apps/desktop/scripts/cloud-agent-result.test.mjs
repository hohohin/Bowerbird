import assert from "node:assert/strict";
import test from "node:test";

import {
  isRenderedDocumentResult,
  selectCloudAgentResultArtifacts,
} from "../src/lib/cloudAgentResult.ts";

function artifact(id, role, userVisible = true) {
  return {
    id,
    conversation_id: "conversation-1",
    kind: role,
    role,
    mime: "image/png",
    bytes: 100,
    sha256: "a".repeat(64),
    user_visible: userVisible,
    expires_at: "2026-09-09T00:00:00.000Z",
  };
}

test("unified Agent with a render manifest is presented as an HTML result", () => {
  const artifacts = [
    artifact("slice-2", "slice_screenshot"),
    artifact("full", "full_page_screenshot"),
    artifact("slice-1", "slice_screenshot"),
    artifact("diagnostic", "diagnostic", false),
  ];
  const manifest = {
    schemaVersion: 1,
    rendererFingerprint: "renderer-1",
    document: { widthCssPx: 1080, heightCssPx: 3200, widthDevicePx: 1080, heightDevicePx: 3200 },
    outputs: [
      { artifactId: "full", role: "full_page_screenshot", index: 0, clipDevicePx: { x: 0, y: 0, width: 1080, height: 3200 } },
      { artifactId: "slice-1", role: "slice_screenshot", index: 1, clipDevicePx: { x: 0, y: 0, width: 1080, height: 1600 } },
      { artifactId: "slice-2", role: "slice_screenshot", index: 2, clipDevicePx: { x: 0, y: 1600, width: 1080, height: 1600 } },
    ],
    renderMs: 1200,
  };

  assert.equal(isRenderedDocumentResult("bowerbird-unified-agent", artifacts, manifest), true);
  assert.deepEqual(selectCloudAgentResultArtifacts(artifacts, manifest).map((item) => item.id), ["full", "slice-1", "slice-2"]);
});

test("screenshot roles remain visible if the manifest cannot be loaded", () => {
  const artifacts = [
    artifact("slice", "slice_screenshot"),
    artifact("full", "full_page_screenshot"),
  ];

  assert.equal(isRenderedDocumentResult("bowerbird-unified-agent", artifacts), true);
  assert.deepEqual(selectCloudAgentResultArtifacts(artifacts).map((item) => item.id), ["full", "slice"]);
});

test("controlled image results keep their existing role filter", () => {
  const artifacts = [
    artifact("input", "input"),
    artifact("stage", "stage_result"),
    artifact("final", "final_result"),
  ];

  assert.equal(isRenderedDocumentResult("bowerbird-controlled-image-edit", artifacts), false);
  assert.deepEqual(selectCloudAgentResultArtifacts(artifacts).map((item) => item.id), ["stage", "final"]);
});

test("unified image results keep every final artifact", () => {
  const artifacts = [
    artifact("scene-1", "final_result"),
    artifact("scene-2", "final_result"),
    artifact("scene-3", "final_result"),
  ];

  assert.equal(isRenderedDocumentResult("bowerbird-unified-agent", artifacts), false);
  assert.deepEqual(selectCloudAgentResultArtifacts(artifacts).map((item) => item.id), ["scene-1", "scene-2", "scene-3"]);
});
