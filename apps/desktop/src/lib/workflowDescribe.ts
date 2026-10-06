import type { WorkflowNode } from "./canvasWorkflow";
import { loadDescribePrompt } from "./describePrompt";
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

export function workflowDescribeInstruction(node: WorkflowNode) {
  return node.prompt.trim() || loadDescribePrompt();
}

export function existingWorkflowCaption(node: WorkflowNode, assetId: string, instruction = workflowDescribeInstruction(node)) {
  const cache = node.describeCache;
  if (cache?.instruction !== instruction || !Array.isArray(cache.results)) return [];
  const sections = cache.results.find(result => result?.assetId === assetId)?.sections;
  return Array.isArray(sections) ? sections.filter(part => part && typeof part.title === "string" && typeof part.body === "string" && part.body.trim()) : [];
}
