import { createHash, randomUUID } from "node:crypto";
import { equal, ok, rejects } from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AgentControlClient, type AgentWorkerFetch, type HttpResponse } from "../control-plane/agent-control-client.ts";
import { cleanupOrphanWorkspaces, RunWorkspace } from "./run-workspace.ts";

function response(status: number, bytes: Uint8Array, contentType = "image/png"): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

function png(): Uint8Array {
  const decode = (globalThis as unknown as { atob(input: string): string }).atob;
  const binary = decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
  return Uint8Array.from(binary, (char: string) => char.charCodeAt(0));
}

test("Run workspace downloads approved artifacts lazily, verifies them, and cleans only its run directory", async () => {
  const image = png();
  let downloads = 0;
  const fetch: AgentWorkerFetch = async (url) => {
    if (url === "https://storage/input") downloads++;
    return response(200, image);
  };
  const control = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "worker" }, fetch);
  const root = join(tmpdir(), `bowerbird-workspace-test-${randomUUID()}`);
  const workspace = new RunWorkspace({
    root,
    runId: "run-1",
    control,
    artifacts: [{
      artifactId: "input-1", conversationId: "conversation-1", runId: "run-1", role: "input",
      stepId: "ref-1", mime: "image/png", bytes: image.byteLength,
      sha256: createHash("sha256").update(image).digest("hex"), userVisible: true, url: "https://storage/input",
    }],
  });
  equal(downloads, 0, "creating the workspace must not inspect image bytes");
  equal((await workspace.readArtifact("input-1")).sha256, createHash("sha256").update(image).digest("hex"));
  equal(downloads, 1);
  ok(existsSync(workspace.path));
  workspace.cleanup();
  equal(existsSync(workspace.path), false);
});

test("Run workspace rebuild recovers a deterministic provider result left by process death", () => {
  const control = new AgentControlClient(
    { controlUrl: "https://control", workerToken: "secret", workerId: "worker" },
    async () => { throw new Error("recovery_must_not_download"); },
  );
  const root = join(tmpdir(), `bowerbird-workspace-recovery-${randomUUID()}`);
  const callId = "a".repeat(64);
  const beforeCrash = new RunWorkspace({ root, runId: "run-recovery", control });
  const written = beforeCrash.writeProviderResult(callId, png());

  const afterCrash = new RunWorkspace({ root, runId: "run-recovery", control });
  equal(afterCrash.providerResult(callId)?.sha256, written.sha256);
  rejects(async () => { afterCrash.providerResult("../foreign"); }, /agent_workspace_call_id_invalid/);
  afterCrash.cleanup();
});

test("Run workspace rejects declared image metadata that does not match bytes", async () => {
  const image = png();
  const control = new AgentControlClient(
    { controlUrl: "https://control", workerToken: "secret", workerId: "worker" },
    async () => response(200, image),
  );
  const workspace = new RunWorkspace({
    root: join(tmpdir(), `bowerbird-workspace-test-${randomUUID()}`),
    runId: "run-2",
    control,
    artifacts: [{
      artifactId: "input-2", conversationId: "conversation-2", runId: "run-2", role: "input",
      mime: "image/png", bytes: image.byteLength, sha256: "a".repeat(64), userVisible: true, url: "https://storage/input",
    }],
  });
  await rejects(async () => await workspace.readArtifact("input-2"), /agent_object_hash_mismatch/);
  workspace.cleanup();
});

test("Run workspace reads only role=html_document artifacts as verified UTF-8 HTML", async () => {
  const htmlBytes = new TextEncoder().encode("<!doctype html><html><body>版式</body></html>");
  const sha256 = createHash("sha256").update(htmlBytes).digest("hex");
  const control = new AgentControlClient(
    { controlUrl: "https://control", workerToken: "secret", workerId: "worker" },
    async () => response(200, htmlBytes, "text/html"),
  );
  const baseArtifact = {
    conversationId: "conversation-html",
    runId: "run-html",
    stepId: "render",
    mime: "text/html",
    bytes: htmlBytes.byteLength,
    sha256,
    userVisible: false,
    url: "https://storage/document",
  } as const;
  const workspace = new RunWorkspace({
    root: join(tmpdir(), `bowerbird-workspace-test-${randomUUID()}`),
    runId: "run-html",
    control,
    artifacts: [
      { ...baseArtifact, artifactId: "html-document", role: "html_document" },
      { ...baseArtifact, artifactId: "wrong-role", role: "diagnostic" },
    ],
  });

  equal(await workspace.readHtmlDocumentArtifact("html-document"), "<!doctype html><html><body>版式</body></html>");
  await rejects(async () => await workspace.readHtmlDocumentArtifact("wrong-role"), /agent_workspace_html_role_invalid/);
  workspace.cleanup();
});

test("Run workspace caches a freshly composed HTML artifact before a signed URL exists", async () => {
  const html = "<!doctype html><html><body>首次租约</body></html>";
  const htmlBytes = new TextEncoder().encode(html);
  const control = new AgentControlClient(
    { controlUrl: "https://control", workerToken: "secret", workerId: "worker" },
    async () => { throw new Error("fresh HTML must be read from the local cache"); },
  );
  const workspace = new RunWorkspace({
    root: join(tmpdir(), `bowerbird-workspace-test-${randomUUID()}`),
    runId: "run-fresh-html",
    control,
  });
  workspace.rememberHtmlDocument({
    artifactId: "fresh-html",
    conversationId: "conversation-html",
    runId: "run-fresh-html",
    role: "html_document",
    stepId: "compose",
    mime: "text/html",
    bytes: htmlBytes.byteLength,
    sha256: createHash("sha256").update(htmlBytes).digest("hex"),
    userVisible: false,
    objectKey: "runs/run-fresh-html/artifacts/document.html",
  }, html);

  equal(await workspace.readHtmlDocumentArtifact("fresh-html"), html);
  workspace.cleanup();
});

test("orphan cleanup removes only old valid Run directories and is idempotent", () => {
  const root = join(tmpdir(), `bowerbird-workspace-cleanup-${randomUUID()}`);
  const oldRun = join(root, "old-run");
  const activeRun = join(root, "active-run");
  const unrelated = join(root, "not_a_run");
  mkdirSync(oldRun, { recursive: true });
  mkdirSync(activeRun, { recursive: true });
  mkdirSync(unrelated, { recursive: true });
  const nowMs = Date.now();
  const oldSeconds = (nowMs - 25 * 60 * 60 * 1_000) / 1_000;
  utimesSync(oldRun, oldSeconds, oldSeconds);
  utimesSync(unrelated, oldSeconds, oldSeconds);

  equal(cleanupOrphanWorkspaces(root, 24 * 60 * 60 * 1_000, nowMs), 1);
  equal(existsSync(oldRun), false);
  equal(existsSync(activeRun), true);
  equal(existsSync(unrelated), true);
  equal(cleanupOrphanWorkspaces(root, 24 * 60 * 60 * 1_000, nowMs), 0);

  rmSync(root, { recursive: true, force: true });
});
