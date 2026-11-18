import type { WorkflowNode } from "../lib/canvasWorkflow";
import { agentChatOptions, rememberAgentDshOptions, type ChatProvider } from "../lib/localChat";
import { workflowAgentProvider } from "../lib/workflowAgentChat";
import { ChatProviderSelect, useChatProviderAccess } from "./creation/ChatProviderSelect";
import { CodexModelSelect, useChatCodexModels } from "./creation/CodexModelSelect";
import { localChatDraft, useLocalChatStore } from "../lib/localChatStore";

/** Agent cards use the exact provider/model controls and availability checks of the composer. */
export function AgentChatControls({ node, busy, onChange, onProviderChange, newChatAction }: {
  newChatAction: React.ReactNode;
  onProviderChange: (provider: ChatProvider) => void;
  node: WorkflowNode; busy: boolean; onChange: (patch: Partial<WorkflowNode>) => void;
}) {
  const provider = workflowAgentProvider(node);
  const access = useChatProviderAccess();
  const models = useChatCodexModels();
  const conversationId = node.chatConversationId;
  const options = useLocalChatStore(state => conversationId
    ? state.drafts[conversationId]?.codexOptions ?? state.summaries[conversationId]?.codexOptions ?? node.chatCodexOptions : node.chatCodexOptions);
  return <div className="workflow-agent-chat-controls">
    <div className="workflow-agent-provider-row"><ChatProviderSelect value={provider} access={access} disabled={busy}
      onChange={next => { if (next !== provider) onProviderChange(next); }} />
      {newChatAction}
    </div>
    <CodexModelSelect provider={provider} allowServiceDefault={provider !== "dsh-local"} value={agentChatOptions(provider, options) ?? {}} catalog={models} disabled={busy}
      onChange={chatCodexOptions => {
        if (provider === "dsh-local") rememberAgentDshOptions(chatCodexOptions);
        if (conversationId) useLocalChatStore.getState().setDraft(conversationId, { ...localChatDraft(conversationId), codexOptions: chatCodexOptions });
        else onChange({ chatCodexOptions });
      }} />
  </div>;
}
