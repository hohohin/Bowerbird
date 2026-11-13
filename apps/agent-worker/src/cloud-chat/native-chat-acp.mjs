import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";

// dsh-acp depends on dsh-llm. Resolve from the pinned profile rather than installing a second copy.
const require = createRequire(import.meta.url);
const { createUserMessage } = await import(pathToFileURL(createRequire(require.resolve("@deepseek-ai/dsh-acp")).resolve("@deepseek-ai/dsh-llm")).href);
export const name = "bowerbird-native-chat-acp";
export const inject = ["agents", "sessions", "sessionPersistence"];

export function apply(ctx) {
  let handle, active = false, currentTurn, messageId, finish, reply, stopReason;
  const done = (reason) => { stopReason = reason; finish?.(); };
  ctx.on("agent/inbox/claimed", ({ agent, message, turn }) => {
    if (active && agent === handle?.agent && message.id === messageId) currentTurn = turn;
  });
  ctx.on("agent/error", ({ agent }) => { if (active && agent === handle?.agent) done("error"); });
  ctx.on("session/event", (session, event) => {
    if (!active || !currentTurn || session !== handle?.agent.session || event.data.turn !== currentTurn) return;
    if (event.type === "assistant/message") reply = event.data.message.content.filter(block => block.type === "text").map(block => block.text).join("");
    if (event.type === "turn/end") done(event.data.reason.kind);
  });
  const connection = new AgentSideConnection(() => ({
    async initialize() { return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true }, authMethods: [] }; },
    async newSession({cwd}) {
      if (handle) throw new Error("session_already_open");
      handle = await ctx.agents.create({ sessionId: process.env.BOWERBIRD_DSH_SESSION_ID, meta: { cwd }, agentOptions: { provider: "deepseek-official", model: "deepseek-flash" } });
      return { sessionId: handle.agent.session.id };
    },
    async loadSession({sessionId}) {
      if (handle || sessionId !== process.env.BOWERBIRD_DSH_SESSION_ID) throw new Error("invalid_session");
      handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: "deepseek-official", model: "deepseek-flash" } });
      return {};
    },
    async prompt({sessionId, prompt}) {
      if (active || !handle || sessionId !== handle.agent.session.id || prompt.length !== 1 || prompt[0].type !== "text") throw new Error("invalid_native_turn");
      const end = Promise.withResolvers();
      const message = createUserMessage({ content: prompt, source: { kind: "user" } });
      active = true; finish = end.resolve; messageId = message.id; currentTurn = undefined; reply = ""; stopReason = undefined;
      try {
        handle.agent.followup(message);
        await end.promise;
        await handle.agent.whenIdle();
        if (stopReason !== "completed") throw new Error("native_turn_incomplete");
        if (!await ctx.sessions.flush(handle.agent.session)) throw new Error("native_session_not_persisted");
        if (reply) await connection.sessionUpdate({sessionId, update:{sessionUpdate:"agent_message_chunk", content:{type:"text", text:reply}}});
        return { stopReason: "end_turn" };
      } finally { active = false; finish = undefined; }
    },
    async cancel({sessionId}) { if (handle?.agent.session.id === sessionId) { handle.agent.cancel({kind:"user"}); done("cancelled"); } },
  }), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
}
