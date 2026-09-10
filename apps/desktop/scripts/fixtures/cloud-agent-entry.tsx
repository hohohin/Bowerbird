import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CreationBoard } from "../../src/components/CreationBoard";
import { useStore } from "../../src/store";
import { api } from "../../src/lib/api";
import "../../src/styles.css";

// Real composer, mocked IPC: no upload, generation or provider is available.
window.__TAURI_INTERNALS__ = { convertFileSrc: (path) => path };
api.localAgentHealth = async () => false;
api.agentZHealth = async () => ({ ok: false });
window.agentCalls = [];
window.directCalls = [];
window.fixtureStore = useStore;
window.fixtureEntitlement = {
  user_id: "test-user", balances: { daily: 100, sub: 100, topup: 0 }, is_test_account: true,
  policy: {
    can_use_byo: true, can_use_cloud: true, max_parallel_jobs: 3,
    can_use_agent_runs: true, max_parallel_agent_runs: 3,
    allowed_agent_skills: ["bowerbird-unified-agent"], agent_budget_options: ["unified-standard"],
  },
};
useStore.setState({
  activeGenProvider: "codex", defaultProvider: "codex", codexHealth: { ok: true },
  cloudAuth: { logged_in: true, cloud_available: true, user_id: "test-user" },
  cloudEntitlement: window.fixtureEntitlement,
  activeProjectId: "entry-test", projectRoutePending: false, projectRouteRevision: 0,
  projects: [{ id: "entry-test", name: "入口验证" }],
  settings: { agent_mode_enabled: true }, assets: [], promptedAssets: [], visualProfiles: [],
  cloudAgentRuns: {}, cloudAgentRunOrder: [],
  startGeneration: async (...args) => { window.directCalls.push(args); },
});
api.cloudAgentStart = async (input) => {
  window.agentCalls.push(input);
  return {
    runId: `run-${window.agentCalls.length}`, conversationId: "conversation",
    skillId: input.skillId, status: "awaiting_approval", intentPrompt: input.intentPrompt,
    referenceAssetIds: [], projectId: input.projectId, threadId: input.threadId,
    createdAt: 1, updatedAt: 1,
    snapshot: { run: { agent_runtime: input.agentRuntime, status: "awaiting_approval" } },
  };
};
const resolveCreativeThread = async () => {
  if (window.pauseThread) await new Promise((resolve) => { window.releaseThread = resolve; });
  return { threadId: "thread", parentNodeId: null, continuationRequestId: null };
};
function Fixture() {
  const [key, setKey] = useState(0);
  window.remountComposer = () => setKey((value) => value + 1);
  return <CreationBoard key={key} embedded projectId="entry-test" resolveCreativeThread={resolveCreativeThread} />;
}
createRoot(document.getElementById("root")).render(<Fixture />);
