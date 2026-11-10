import type { WorkflowNode } from "../lib/canvasWorkflow";
import { workflowAgentProvider } from "../lib/workflowAgentChat";
import { ChatProviderSelect, useChatProviderAccess } from "./creation/ChatProviderSelect";
import { CodexModelSelect, useChatCodexModels } from "./creation/CodexModelSelect";
import { localChatDraft, useLocalChatStore } from "../lib/localChatStore";

/** Agent cards use the exact provider/model controls and availability checks of the composer. */
export function AgentChatControls({ node, busy, active, onChange }: {
  node: WorkflowNode; busy: boolean; active: boolean; onChange: (patch: Partial<WorkflowNode>) => void;
}) {
  const provider = workflowAgentProvider(node);
  const access = useChatProviderAccess(active);
  const models = useChatCodexModels(active && provider === "codex-local");
  const conversationId = node.chatConversationId;
  const options = useLocalChatStore(state => conversationId
    ? state.drafts[conversationId]?.codexOptions ?? state.summaries[conversationId]?.codexOptions ?? node.chatCodexOptions : node.chatCodexOptions);
  return <div className="workflow-agent-chat-controls">
    <ChatProviderSelect value={provider} access={access} disabled={busy}
      onChange={node.chatConversationId ? undefined : chatProvider => onChange({ chatProvider, chatCodexOptions: undefined })} />
    {provider === "codex-local" && <CodexModelSelect value={options ?? {}} catalog={models} disabled={busy}
      onChange={chatCodexOptions => {
        if (conversationId) useLocalChatStore.getState().setDraft(conversationId, { ...localChatDraft(conversationId), codexOptions: chatCodexOptions });
        else onChange({ chatCodexOptions });
      }} />}
  </div>;
}
