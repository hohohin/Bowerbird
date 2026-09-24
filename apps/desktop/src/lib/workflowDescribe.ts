import { api } from "./api";
import type { CaptionSection } from "./types";

export function workflowCaptionSections(payload: string): CaptionSection[] {
  try {
    const value = JSON.parse(payload);
    if (Array.isArray(value?.sections)) {
      const sections = value.sections.filter((part: CaptionSection) => part && typeof part.title === "string" && typeof part.body === "string" && part.body.trim());
      if (sections.length) return sections;
    }
    return typeof value?.text === "string" && value.text.trim() ? [{ title: "提示词", body: value.text }] : [];
  } catch { return []; }
}

export async function existingWorkflowCaption(assetId: string) {
  // The API returns newest first, matching the asset detail panel's current caption.
  const latest = (await api.listAnalysesByAsset(assetId)).find(item => item.kind === "caption");
  return latest ? workflowCaptionSections(latest.payload) : [];
}
