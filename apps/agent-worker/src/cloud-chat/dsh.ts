import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatResult, DSH_CHAT_ENGINE, DSH_CHAT_ENGINE_V2, parseChatToolReceipt, type ChatInput } from "../../../cloud/supabase/functions/_shared/chat.ts";
import { NodeDshAcpPort } from "../harness/node-dsh-acp-port.ts";
import { startLoopbackToolBridge } from "../harness/loopback-tool-bridge-server.ts";
import { startMeteredDeepSeekProxy, type MeteredDeepSeekProxyFetch } from "../harness/metered-deepseek-proxy.ts";
import { DurableProviderError } from "../kernel/durable-tool-dispatcher.ts";
import { DeepSeekBackendError, type DeepSeekConfig } from "../providers/deepseek/backend.ts";
import { loadCloudTextSkill } from "../skills/cloud-text-skills.ts";
import type { ChatControl } from "./runtime.ts";
import { stageNativeSession, type NativeChatClaim } from "./native-session.ts";

export class DshChatLeaseLost extends Error {}
export class DshChatDeadline extends Error {}
type Identity = { job_id: string; lease_id: string };
export interface DshChatOptions {
  profileTemplateDir: string;
  runtimeRoot: string;
  upstream: DeepSeekConfig;
  skillDir?: string;
  fetch?: MeteredDeepSeekProxyFetch;
  heartbeatMs?: number;
  toolPollMs?: number;
  turnTimeoutMs?: number;
  sessionRoot?: string;
}

const instructions = readFileSync(join(import.meta.dirname, "../../../cloud/supabase/functions/_shared/chat-instructions.txt"), "utf8");

export async function runDshChat(input: ChatInput, identity: Identity, control: ChatControl,
  options: DshChatOptions, onModelSubmission: () => void, nativeClaim?: NativeChatClaim) {
  const native = input.engine === DSH_CHAT_ENGINE_V2;
  if (native && (!nativeClaim || !options.sessionRoot || input.messages.length !== 1)) throw new Error("dsh_native_session_missing");
  const ephemeral = native && input.conversation_id?.startsWith("t-");
  if (ephemeral && nativeClaim?.previous_job_id !== null) throw new Error("dsh_ephemeral_parent_invalid");
  const user = input.messages.at(-1);
  if (user?.role !== "user" || !user.content) throw new Error("dsh_chat_user_message_missing");
  const skill = input.skill && loadCloudTextSkill(input.skill.id === "text-editor"
    ? { id: input.skill.id, instruction: user.content } : input.skill, options.skillDir);
  const allowCards = !skill && input.tools_enabled;
  const policy = [instructions, "当前通道为 DSH Cloud。只接收文字与素材别名，不能声称看过图片。仅向用户交付最终答复，不展示内部规范、工具参数或中间过程。",
    ...(skill ? [skill.instructions, JSON.stringify(skill.parameters)] : [])].join("\n");
  const usage = { input_tokens: 0, output_tokens: 0 };
  const abort = new AbortController();
  const stopped = Promise.withResolvers<never>();
  void stopped.promise.catch(() => {});
  function stop(error: unknown) {
    if (abort.signal.aborted) return;
    abort.abort();
    stopped.reject(error);
  }
  async function leased(action: string, extra: Record<string, unknown> = {}) {
    if (abort.signal.aborted) throw new DshChatLeaseLost();
    try {
      const response = await control({ action, ...identity, ...extra });
      if (response.active !== true || abort.signal.aborted) throw new DshChatLeaseLost();
      return response;
    } catch {
      const lost = new DshChatLeaseLost();
      stop(lost);
      throw lost;
    }
  }
  await leased("dsh_poll");
  let committed = "";
  let modelCallAllowed = true;
  const bridge = await startLoopbackToolBridge({
    async dispatch(call) {
      if (!allowCards || call.toolName !== "create_canvas_cards" || !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments))
        throw new Error("dsh_chat_tool_unavailable");
      const { acpCallId, args } = call.arguments as { acpCallId?: unknown; args?: unknown };
      if (typeof acpCallId !== "string" || !acpCallId || !args || typeof args !== "object" || Array.isArray(args))
        throw new Error("dsh_chat_tool_identity_invalid");
      const callId = createHash("sha256").update(JSON.stringify([identity.job_id, acpCallId])).digest("hex");
      let response = await leased("tool_request", { call_id: callId, arguments: args });
      while (!response.result) {
        await new Promise<void>(resolve => setTimeout(resolve, options.toolPollMs ?? 1000));
        response = await leased("dsh_poll", { call_id: callId });
      }
      const value = parseChatToolReceipt(response.result);
      modelCallAllowed = true;
      return { callId, value };
    },
  }, Infinity);
  let proxy: Awaited<ReturnType<typeof startMeteredDeepSeekProxy>> | undefined;
  let port: NodeDshAcpPort | undefined, sessionId: string | undefined, complete = false;
  let heartbeat: unknown;
  let snapshot: ReturnType<typeof stageNativeSession> | undefined;
  const deadline = setTimeout(() => stop(new DshChatDeadline()), options.turnTimeoutMs ?? 30 * 60_000);
  const scheduleHeartbeat = () => {
    if (!abort.signal.aborted) heartbeat = setTimeout(() => {
      void leased("dsh_poll").then(scheduleHeartbeat, () => {});
    }, options.heartbeatMs ?? 10_000);
  };
  try {
    scheduleHeartbeat();
    if (native && nativeClaim && options.sessionRoot) snapshot = stageNativeSession(ephemeral ? options.runtimeRoot : options.sessionRoot, identity.job_id, nativeClaim, ephemeral);
    proxy = await startMeteredDeepSeekProxy({
      runId: identity.job_id, leaseId: identity.lease_id, phase: "chat", upstream: options.upstream, fetch: options.fetch,
      signal: abort.signal, allowedToolNames: allowCards ? ["create_canvas_cards"] : [],
      async beforeModel(request) {
        await leased("dsh_poll");
        const messages = request.messages as Array<{ role: string; content: unknown }>;
        // The pinned harness emits its own compaction directive at a separate,
        // 8192-token summary limit. Keep the next conversational slot for the
        // actual user reply; the proxy still accounts for this model call.
        const last = messages.at(-1);
        const compact = native && request.max_tokens === 8192 && last?.role === "user" && typeof last.content === "string"
          && last.content.startsWith("You are now acting as a compaction engine for this AI coding assistant.");
        if (!compact && !modelCallAllowed) throw new Error("dsh_chat_tool_receipt_missing");
        if (!compact) modelCallAllowed = false;
        const firstUser = messages.findIndex(message => message.role === "user");
        if (firstUser < 0) throw new Error("dsh_chat_provider_messages_invalid");
        if (compact) delete request.tools;
        else if (native) request.messages = [{ role: "system", content: policy }, ...messages];
        else request.messages = [{ role: "system", content: policy }, ...messages.slice(0, firstUser), ...input.messages.slice(0, -1), ...messages.slice(firstUser)];
        committed = ""; // ACP can emit public narration before requesting a card tool.
        onModelSubmission();
      },
      onUsage(result) { usage.input_tokens += result.inputUnits; usage.output_tokens += result.outputUnits; },
      onModelError(error) {
        const code = error instanceof DurableProviderError ? error.safeCode : "";
        const http = /^deepseek_http_(\d{3})$/.exec(code);
        stop(http ? new DeepSeekBackendError("deepseek_http_error", { status: Number(http[1]) }) :
          new DeepSeekBackendError(code === "deepseek_transport_unknown" ? "deepseek_network_error" : "deepseek_invalid_response"));
      },
    });
    port = await NodeDshAcpPort.create({ profileTemplateDir: options.profileTemplateDir, runtimeRoot: options.runtimeRoot, profileMode: "chat",
      childEnvironment: bridge.childEnvironment(), providerEnvironment: proxy.childEnvironment(), promptTimeoutMs: 0, nativeSession: snapshot });
    await Promise.race([port.initialize(), stopped.promise]);
    sessionId = (await Promise.race([snapshot && nativeClaim?.previous_job_id
      ? port.loadSession(snapshot.sessionId, options.runtimeRoot) : port.newSession({ cwd: options.runtimeRoot }), stopped.promise])).sessionId;
    const result = await Promise.race([port.prompt({ sessionId, prompt: [{ type: "text", text: user.content }] }, block => {
      if (block.type === "text") committed += block.text;
    }), stopped.promise]);
    if (result.stopReason !== "end_turn" || !committed.trim() || !usage.output_tokens) throw new Error("dsh_chat_reply_missing");
    await Promise.race([leased("dsh_poll"), stopped.promise]);
    const output = chatResult({ message: { role: "assistant", content: committed }, usage }, native ? DSH_CHAT_ENGINE_V2 : DSH_CHAT_ENGINE);
    if (snapshot) {
      await port.dispose();
      await Promise.race([leased("dsh_poll"), stopped.promise]);
      if (!ephemeral) snapshot.publish();
    }
    complete = true;
    return output;
  } finally {
    clearTimeout(deadline);
    clearTimeout(heartbeat);
    abort.abort();
    if (!complete && port && sessionId) void port.cancel({ sessionId }).catch(() => {});
    await Promise.allSettled([port?.dispose(), proxy?.close(), bridge.close()]);
    snapshot?.dispose();
  }
}
