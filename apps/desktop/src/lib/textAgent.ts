import { api } from "./api";
import { useStore } from "../store";
import { canStartAnotherAgentRun, canUseAgentRun, canUseByo } from "./entitlement";
import { enqueueCloudAgentRunOperation } from "./cloudAgentRuntime";
import type { CloudAgentRunRecord } from "./types";

export type TextAgentProvider = "codex-cli" | "cloud";
export const TEXT_AGENT_LABELS = { "codex-cli": "Codex CLI", cloud: "Cloud DSH" };
export interface TextAgentMessage { role: "user" | "assistant"; text: string }
export interface TextAgentJob { read(preview?: (text: string) => void): Promise<string | null>; cancel(): Promise<unknown>; pollMs?: number }
const TEXT_AGENT_LIMIT = 16000;

export function textAgentUnavailable(provider: TextAgentProvider, state = useStore.getState()): string | undefined {
  if (provider === "codex-cli") {
    if (!canUseByo(state.cloudEntitlement)) return "当前权益不支持本机 Codex";
    if (!state.codexHealth?.ok) return "请先在设置中连接 Codex CLI";
    return;
  }
  return cloudTextAgentUnavailable(state);
}
function cloudTextAgentUnavailable(state: ReturnType<typeof useStore.getState>): string | undefined {
  const { cloudAuth: auth, cloudEntitlement: entitlement } = state;
  if (!auth?.logged_in) return "请先登录 Bowerbird 账号";
  if (!entitlement || !auth.cloud_available || entitlement.user_id !== auth.user_id || !entitlement.is_test_account || !canUseAgentRun(entitlement, "bowerbird-unified-agent")) return "当前账号尚未开放 Cloud DSH";
  const running = Object.values(state.cloudAgentRuns).filter(run => !["succeeded", "failed", "cancelled"].includes(run.status)).length;
  if (!canStartAnotherAgentRun(entitlement, running, "bowerbird-unified-agent")) return "Agent 并发已满，请等待当前任务结束";
}

export function textAgentSource(segment: string, messages: TextAgentMessage[]): string {
  const source = JSON.stringify({ segment: segment || "（空白段落）", conversation: messages });
  if (source.length > TEXT_AGENT_LIMIT) throw new Error("本次段落和对话超过 16000 字，请重新开始对话或缩短段落。");
  return source;
}
function resultText(text: unknown): string {
  if (typeof text !== "string" || !text.trim() || text.length > TEXT_AGENT_LIMIT) throw new Error("Agent 未返回有效文本，请检查原任务结果。");
  return text;
}

export async function startTextAgent(input: { provider: TextAgentProvider; prompt: string; source: string; images?: string[]; projectId?: string; sessionId: string; requestId: string; editor?: boolean }, onLocalStart?: (job: TextAgentJob) => void): Promise<TextAgentJob> {
  const reason = textAgentUnavailable(input.provider);
  if (reason) throw new Error(reason);
  if (!input.prompt.trim() || input.prompt.length > 3600) throw new Error("请输入较短的要求（最多 3600 字）。");
  if (input.editor && input.source.length > TEXT_AGENT_LIMIT) throw new Error("本次段落和对话超过 16000 字，请重新开始对话或缩短段落。");
  if (input.provider === "codex-cli") {
    // Isolate every turn; only this bubble's explicit history is passed to the CLI.
    const instruction = `输入字段：segment（选中段落）、conversation（此前对话）。只返回供插入的 Markdown 文本。\n用户要求：${input.prompt}`;
    const job = localTextAgentJob(input.requestId, input.editor);
    onLocalStart?.(job);
    const delivery = await api.agentDsWorkflowStart(input.requestId, instruction, input.source, input.editor ? "text-editor" : "agent-text", input.images ?? [],
      { projectId: input.sessionId, nodeId: input.sessionId }, undefined, "codex-cli", true);
    if (!delivery.autoDelivered) throw new Error("Codex 请求已保留，请检查本机 Codex 状态后取回原请求。");
    return job;
  }
  return startCloudTextRewrite({ instruction: `bowerbird:cloud-text-skill:v1\n${JSON.stringify({ id: "text-editor", instruction: input.prompt })}`,
    source: input.source, projectId: input.projectId });
}
/** Pure text work is kept in Agent history, without creating canvas sessions. */
export async function startCloudTextRewrite(input: { instruction: string; source: string; projectId?: string }): Promise<TextAgentJob> {
  const reason = textAgentUnavailable("cloud");
  if (reason) throw new Error(reason);
  const userId = useStore.getState().cloudAuth?.user_id;
  const assertAccount = () => { if (useStore.getState().cloudAuth?.user_id !== userId) throw new Error("账号已变化，请登录原账号后在任务中心查看原任务。"); };
  const run = await api.cloudAgentStart({ intentPrompt: input.instruction, textRewrite: { source: input.source }, references: [],
    projectId: input.projectId, imageProvider: "cloud", skillId: "bowerbird-unified-agent", agentRuntime: "dsh" });
  assertAccount();
  useStore.getState().openCloudAgentRun(run, { navigate: false });
  return {
    cancel: () => enqueueCloudAgentRunOperation(run.runId, async () => {
      assertAccount();
      const current = await api.cloudAgentCancel(run.runId);
      useStore.getState().updateCloudAgentRun(current);
    }),
    read: preview => enqueueCloudAgentRunOperation(run.runId, async () => {
      assertAccount();
      const current = await api.cloudAgentGet(run.runId);
      assertAccount();
      if (current.runId !== run.runId) throw new Error("Agent 返回结果与本次请求不一致，未写入文档。");
      useStore.getState().updateCloudAgentRun(current);
      const result = cloudTextAgentResult(current);
      if (result === null && preview) preview(cloudTextPreview(current));
      return result;
    }),
  };
}
function cloudTextAgentResult(current: CloudAgentRunRecord): string | null {
  if (["failed", "cancelled"].includes(current.status)) throw new Error(current.snapshot.run.safe_message || "Agent 任务已结束，未写入文档。");
  if (current.status.startsWith("awaiting_")) throw new Error("Cloud DSH 未按文本模式执行，请在任务中心检查原任务。");
  if (current.status !== "succeeded") return null;
  const payload = current.snapshot.events.find(event => event.type === "text.result")?.display_payload;
  if (payload?.schemaVersion !== 1) throw new Error("Cloud DSH 未返回有效文本，请在任务中心检查原任务。");
  return resultText(payload.text);
}

function cloudTextPreview(current: CloudAgentRunRecord): string {
  let attempt = 0;
  let preview = "";
  for (const event of current.snapshot.events) {
    const chunk = event.display_payload;
    if (event.type !== "text.rewrite.delta" || chunk?.schemaVersion !== 1 ||
        typeof chunk.attempt !== "number" || !Number.isSafeInteger(chunk.attempt) || chunk.attempt < 1 ||
        typeof chunk.text !== "string" || typeof chunk.offset !== "number") continue;
    if (chunk.attempt > attempt && chunk.offset === 0 && chunk.text === "") {
      attempt = chunk.attempt;
      preview = "";
    }
    if (chunk.attempt === attempt && chunk.offset === preview.length && preview.length + chunk.text.length <= TEXT_AGENT_LIMIT) {
      preview += chunk.text;
    }
  }
  return preview;
}

export function localTextAgentJob(requestId: string, streaming = false): TextAgentJob {
  return {
    cancel: () => api.agentDsWorkflowCancel(requestId),
    ...(streaming ? { pollMs: 300 } : {}),
    async read(preview) {
      const result = await api.agentDsWorkflowResult(requestId);
      if (!result) {
        if (streaming && preview) {
          const events = await api.agentDsWorkflowProgress(requestId);
          const update = events.find(event => event.kind === "text-preview" && event.id === requestId);
          if (update && update.text.length <= TEXT_AGENT_LIMIT) preview(update.text);
        }
        return null;
      }
      if (result.schemaVersion !== 1 || result.requestId !== requestId) throw new Error("Agent 返回结果与本次请求不一致，未写入文档。");
      if (result.error) throw new Error(result.error);
      return resultText(result.text);
    },
  };
}
