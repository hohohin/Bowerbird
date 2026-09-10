import type { CloudAgentArtifact, CloudAgentSnapshot } from "./types";

const RENDERED_DOCUMENT_ROLES = new Set([
  "viewport_screenshot",
  "full_page_screenshot",
  "slice_screenshot",
]);

const IMAGE_RESULT_ROLES = new Set([
  "control_reference",
  "stage_result",
  "final_result",
]);

type RenderManifest = CloudAgentSnapshot["renderManifest"];

/** Canvas payloads omit full selection events; prefer final images over intermediate copies. */
export function countCloudAgentResultImages(artifacts: Array<{ role?: string; mime?: string; user_visible?: boolean }>): number {
  const images = artifacts.filter((item) => item.user_visible && item.mime?.startsWith("image/"));
  const finals = images.filter((item) => item.role === "final_result");
  return finals.length || images.filter((item) => IMAGE_RESULT_ROLES.has(item.role ?? "") || RENDERED_DOCUMENT_ROLES.has(item.role ?? "")).length;
}

function visibleImages(artifacts: CloudAgentArtifact[]): Map<string, CloudAgentArtifact> {
  return new Map(artifacts
    .filter((artifact) => artifact.user_visible && artifact.mime.startsWith("image/"))
    .map((artifact) => [artifact.id, artifact]));
}

/**
 * Result presentation follows the artifacts a Run actually produced, not the Skill that planned them.
 * Unified Agent runs may choose the same HTML renderer used by the legacy HTML Skill.
 */
export function isRenderedDocumentResult(
  skillId: string,
  artifacts: CloudAgentArtifact[],
  renderManifest?: RenderManifest,
): boolean {
  return skillId === "bowerbird-html-layout-render"
    || !!renderManifest
    || artifacts.some((artifact) => artifact.user_visible && RENDERED_DOCUMENT_ROLES.has(artifact.role));
}

export function selectCloudAgentResultArtifacts(
  artifacts: CloudAgentArtifact[],
  renderManifest?: RenderManifest,
  events?: CloudAgentSnapshot["events"],
): CloudAgentArtifact[] {
  const visible = visibleImages(artifacts);
  const selected = [...(events ?? [])].sort((a, b) => b.seq - a.seq).find((event) =>
    event.type === "result.ready" && event.display_payload?.selectionVersion === 1)?.display_payload?.visibleArtifactIds;
  if (Array.isArray(selected)) return selected.flatMap((id) => typeof id === "string" && visible.has(id) ? [visible.get(id)!] : []);
  if (renderManifest) {
    const ordered = renderManifest.outputs
      .map((output) => visible.get(output.artifactId))
      .filter((artifact): artifact is CloudAgentArtifact => !!artifact);
    if (ordered.length) return ordered;
  }

  const rendered = [...visible.values()].filter((artifact) => RENDERED_DOCUMENT_ROLES.has(artifact.role));
  if (rendered.length) {
    const roleOrder = new Map([
      ["full_page_screenshot", 0],
      ["viewport_screenshot", 1],
      ["slice_screenshot", 2],
    ]);
    return rendered.sort((left, right) => (roleOrder.get(left.role) ?? 9) - (roleOrder.get(right.role) ?? 9));
  }

  return [...visible.values()].filter((artifact) => IMAGE_RESULT_ROLES.has(artifact.role));
}
