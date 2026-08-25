const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RUN_DIRECTORIES = [
  "inputs",
  "checkpoints",
  "plans",
  "artifacts",
  "feedback",
  "local",
] as const;

export function agentRunObjectDirectories(runId: string): string[] {
  if (!RUN_ID.test(runId)) throw new Error("agent_cleanup_run_id_invalid");
  return RUN_DIRECTORIES.map((directory) => `runs/${runId}/${directory}`);
}

export function checkedAgentObjectKey(runId: string, objectKey: unknown): string | null {
  if (!RUN_ID.test(runId) || typeof objectKey !== "string") return null;
  if (!objectKey.startsWith(`runs/${runId}/`) || objectKey.length > 512 || objectKey.includes("..")) return null;
  return objectKey;
}

export function storageListObjectKey(directory: string, name: unknown): string | null {
  if (typeof name !== "string" || !name || name === ".emptyFolderPlaceholder" || name.includes("/") || name.includes("..")) {
    return null;
  }
  return `${directory}/${name}`;
}
