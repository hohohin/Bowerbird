import { api } from "../../../src/lib/api";

/** Match the native canvas projection when a test completes a mocked generation. */
export async function publishGeneration(args: unknown[], paths: string[]) {
  const { projectId } = args[9] as { projectId: string };
  const { jobId, turnKey } = args[12] as { jobId: string; turnKey: string };
  const canvas = await api.projectCanvasGet(projectId);
  const base = canvas.nodes[0];
  await api.projectCanvasNodeCreate({ ...base, projectId, id: `gen-prompt:${jobId}:${turnKey}:0`, kind: "prompt", assetId: null, role: null,
    hiddenAt: null, payloadJson: JSON.stringify({ schema_version: 1, job_id: jobId, turn_key: turnKey, text: args[0], status: "done", provider: args[3] }) });
  for (const [index, path] of paths.entries()) {
    await api.projectCanvasNodeCreate({ ...base, projectId, id: `gen-output:${jobId}:${turnKey}:${index}`, kind: "asset", role: "output",
      assetId: await api.localAgentFindAssetId(path), hiddenAt: null, payloadJson: JSON.stringify({ execution: { job_id: jobId, turn_key: turnKey } }) });
  }
}
