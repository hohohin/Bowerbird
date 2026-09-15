/** Keep frontend task/navigation locators aligned with Rust `projection_id`. */
export function generationPromptNodeId(jobId: string, turnKey: string): string {
  return `gen-prompt:${jobId}:${turnKey}:0`;
}

export function generationOutputNodeId(jobId: string, turnKey: string, assetId: string): string {
  return `gen-output:${jobId}:${turnKey}:${assetId}`;
}

export function agentPromptNodeId(launchId: string): string {
  return `agent-prompt:${launchId}:0:0`;
}

export function agentGroupNodeId(runId: string): string {
  return `agent-group:${runId}:0:0`;
}

export function agentArtifactNodeId(runId: string, artifactId: string): string {
  return `agent-artifact:${runId}:0:${artifactId}`;
}
