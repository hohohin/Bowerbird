import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  isRenderedDocumentResult,
  selectCloudAgentResultArtifacts,
  countCloudAgentResultImages,
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

test("eight-image delivery counts finals, not the reference and intermediate copies", () => {
  const artifacts = [artifact("input", "input"), ...Array.from({ length: 8 }, (_, i) => artifact(`stage-${i}`, "stage_result")),
    ...Array.from({ length: 8 }, (_, i) => artifact(`final-${i}`, "final_result")), artifact("private", "diagnostic", false)];
  const events = [{ seq: 80, type: "result.ready", display_payload: { selectionVersion: 1,
    visibleArtifactIds: Array.from({ length: 8 }, (_, i) => `final-${i}`) } }];
  assert.equal(artifacts.filter(a => a.user_visible).length, 17);
  assert.equal(countCloudAgentResultImages(artifacts), 8);
  assert.equal(selectCloudAgentResultArtifacts(artifacts, undefined, events).length, 8);
  assert.equal(countCloudAgentResultImages([artifact("input", "input")]), 0);
  assert.equal(countCloudAgentResultImages([artifact("stage", "stage_result")]), 1);
});

test("actual result grid renders all eight non-HTML finals without legacy step events", () => {
  const source = readFileSync(new URL("../src/components/CloudAgentPanel.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("CloudAgentPanel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isJsxExpression(node) && node.expression?.getText(file).startsWith("generatedArtifacts.length > 0 &&")) expression = node.expression.getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(expression, "result gallery must not depend on HTML or step.completed events");
  const generatedArtifacts = Array.from({ length: 8 }, (_, i) => artifact(`final-${i}`, "final_result"));
  let opened;
  const bindings = { React, generatedArtifacts, renderedDocumentRun: false, run: { snapshot: {} },
    artifactPreviews: Object.fromEntries(generatedArtifacts.map(a => [a.id, { path: `/verified/${a.id}.jpg` }])),
    convertFileSrc: path => path, artifactRoleLabel: () => "最终结果图", setLightbox: value => { opened = value; } };
  const js = ts.transpileModule(`const result = (${expression});`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  const tree = new Function(...Object.keys(bindings), js + "return result;")(...Object.values(bindings));
  const html = renderToStaticMarkup(tree);
  assert.equal((html.match(/<img /g) ?? []).length, 8);
  assert.ok(html.includes("图片结果"));
  const buttons = tree.props.children[1].props.children;
  buttons[5].props.onClick();
  assert.equal(opened.images.length, 8);
  assert.equal(opened.index, 5);
});

test("adaptive final selection overrides render manifests and excludes discarded images", () => {
  const artifacts = [artifact("draft", "stage_result"), artifact("old-render", "full_page_screenshot"),
    artifact("selected-b", "final_result"), artifact("selected-a", "final_result")];
  const manifest = { outputs: [{ artifactId: "old-render", role: "full_page_screenshot" }] };
  const events = [{ seq: 80, type: "result.ready", display_payload: {
    selectionVersion: 1, visibleArtifactIds: ["selected-a", "selected-b"],
  } }];
  assert.deepEqual(selectCloudAgentResultArtifacts(artifacts, manifest, events).map((item) => item.id), ["selected-a", "selected-b"]);
  assert.deepEqual(selectCloudAgentResultArtifacts(artifacts, manifest, [{ seq: 81, type: "result.ready", display_payload: {
    selectionVersion: 1, visibleArtifactIds: ["missing"],
  } }]), []);
});

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
