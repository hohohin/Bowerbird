import { deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import type { AgentControlClient } from "../control-plane/agent-control-client.ts";
import { VisualObservationMemory, type VisualObservationReference } from "./visual-observation-memory.ts";

const call = { toolName: "understand_asset", arguments: { assetId: "product", focus: "general" } };
const callId = "c".repeat(64);
const assets = [{ artifactId: "product", sha256: "a".repeat(64) }];
const value = { schemaVersion: 1, assetId: "product", summary: "白底产品图",
  observations: Array.from({ length: 5 }, () => ({ category: "subject", detail: "产品🙂".repeat(200) })) };

test("visual facts survive checkpoint/lease restart and page losslessly without another visual call", async () => {
  let references: VisualObservationReference[] = [];
  let downloads = 0;
  const control = {
    async getArtifactByCall(run: string, lease: string, id: string) {
      deepEqual([run, lease, id], ["run", "new-lease", callId]);
      return { role: "diagnostic", mime: "application/json", url: "https://fixture/observation", sha256: "verified-hash" };
    },
    async downloadVerifiedJson(url: string, hash: string, limit: number) {
      deepEqual([url, hash, limit], ["https://fixture/observation", "verified-hash", 65536]);
      downloads++; return value;
    },
  } as unknown as AgentControlClient;
  const memory = new VisualObservationMemory({ runId: "run", leaseId: "old-lease", assets, control,
    save: async refs => { references = JSON.parse(JSON.stringify(refs)); } });
  await memory.remember(call, { callId, value });
  deepEqual((await memory.replay(call))!.value, value);
  equal(downloads, 0);
  equal(references.length, 1);
  const restored = new VisualObservationMemory({ runId: "run", leaseId: "new-lease", assets, references, control,
    save: async () => { throw new Error("read must not save"); } });
  let id: string | null = restored.catalog()[0]!.contextId;
  let text = "";
  while (id) {
    const result = await restored.readContext({ toolName: "read_context", arguments: { id } });
    const page = (result!.value as { content: { text: string; nextId: string | null } }).content;
    text += page.text; id = page.nextId;
  }
  deepEqual(JSON.parse(text), value);
  deepEqual(await restored.replay(call), { callId, value });
  equal(downloads, 1);
  equal(await restored.replay({ ...call, arguments: { assetId: "product", focus: "text" } }), undefined);
  equal(await restored.replay({ ...call, arguments: { ...call.arguments, extra: true } }), undefined);
  for (const invalid of [`vision:${callId}:999`, `vision:${"d".repeat(64)}:0`]) {
    const result = await restored.readContext({ toolName: "read_context", arguments: { id: invalid } });
    equal((result!.value as { status: string }).status, "retry_required");
  }
  for (const changedAssets of [[], [{ artifactId: "product", sha256: "b".repeat(64) }]]) {
    const changed = new VisualObservationMemory({ runId: "run", leaseId: "new-lease", assets: changedAssets,
      references, control, save: async () => {} });
    equal(changed.catalog().length, 0);
    equal(await changed.replay(call), undefined);
  }
});

test("failed checkpoint persistence is not acknowledged as remembered; durable result can be indexed on restart", async () => {
  const options = { runId: "run", leaseId: "lease", assets, control: {} as AgentControlClient };
  const failed = new VisualObservationMemory({ ...options, save: async () => { throw new Error("checkpoint_unavailable"); } });
  await rejects(() => failed.remember(call, { callId, value }), /checkpoint_unavailable/);
  equal(failed.catalog().length, 0);
  const restarted = new VisualObservationMemory({ ...options, save: async () => {} });
  await restarted.remember(call, { callId, value });
  deepEqual((await restarted.replay(call))!.value, value);
});
