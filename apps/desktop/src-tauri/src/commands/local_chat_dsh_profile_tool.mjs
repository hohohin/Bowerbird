// Embedded after the immutable handshake path and card tool schema by the native host.
// DSH 0.2 keeps presets in the profile, so the tool resolves the running turn at call time;
// only `node:fs` is imported because the preset ships outside the harness module tree.
import { readFileSync } from "node:fs";

export const name = "bowerbird-chat-cards";
export const inject = ["tools"];
const statePath = __STATE__;
const tool = __TOOL__;

function turn(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return undefined;
  try {
    const all = JSON.parse(readFileSync(statePath, "utf8"));
    const entry = all !== null && typeof all === "object" ? all[sessionId] : undefined;
    if (!entry || typeof entry.endpoint !== "string" || typeof entry.token !== "string") return undefined;
    return entry;
  } catch {
    return undefined;
  }
}

export function apply(ctx) {
  // Older harnesses present tools through this hook; current ones do not expose it.
  if (typeof ctx.tools.presentAs === "function") ctx.tools.presentAs("native");
  ctx.tools.register({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    output: { schema: {}, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const entry = turn(exec.agent?.id);
      if (!entry || !exec.callId) throw new Error("This tool belongs to a different chat turn.");
      const response = await fetch(entry.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.token}` },
        body: JSON.stringify({ sessionId: exec.agent.id, callId: exec.callId, arguments: args }),
        signal: exec.signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error("Bowerbird chat tool connection is no longer available.");
      return response.json();
    },
  });
  // A preset is the agent's ancestor scope: restrict inherited tools on this turn's agent only.
  ctx.on("agent/created", ({ agent }) => {
    if (turn(agent.id)) agent.ctx.tools.restrict({ allow: [tool.name] });
  });
}
