import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { AuthSnapshot } from "../lib/types";
import { cloudAccountIssue, type ProviderIssue } from "../lib/generationAvailability";
import { layerDecompositionAvailable } from "../lib/workflowLayerDecompose";
import { userErrorMessage } from "../lib/userError";

/** Existing workspaces can be reused offline. Check the lightweight local index before requesting a Cloud quote. */
export function useWorkflowLayerIssue(inputs: string[], auth: AuthSnapshot | null, workspaceIds: Set<string>) {
  const key = JSON.stringify([...new Set(inputs)].sort());
  type Status = { key: string; auth: AuthSnapshot | null; issue: ProviderIssue | null; existing: Set<string> };
  const [status, setStatus] = useState<Status>();
  useEffect(() => {
    if (key === "[]") return;
    let current = true;
    let revision = 0;
    async function check() {
      const version = ++revision;
      let existing = new Set<string>();
      let issue: ProviderIssue | null = null;
      try {
        existing = new Set(await api.layerWorkspaceAssetIds());
        if ((JSON.parse(key) as string[]).some(id => !existing.has(id))) {
          issue = cloudAccountIssue(auth);
          if (!issue && !await layerDecompositionAvailable()) issue = { message: "云端拆分服务暂不可用。" };
        }
      } catch (error) { issue = { message: userErrorMessage(error, "暂时无法检查分层服务，请稍后再试。") }; }
      if (current && version === revision) setStatus({ key, auth, existing, issue });
    }
    void check();
    window.addEventListener("focus", check);
    return () => { current = false; window.removeEventListener("focus", check); };
  }, [key, auth, workspaceIds]);
  return useCallback((id: string): ProviderIssue | null => {
    if (workspaceIds.has(id)) return null;
    if (!status || status.key !== key || status.auth !== auth) return { message: "正在检查分层工程与服务…" };
    return status.existing.has(id) ? null : status.issue;
  }, [workspaceIds, status, auth, key]);
}
