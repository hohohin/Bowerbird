// Embedded after immutable per-turn connection and schema literals by the native host.
// No package imports: the preset is outside the harness's node_modules tree.
export const name = "bowerbird-chat-cards";
export const inject = ["tools"];
export function apply(ctx) {
  ctx.tools.presentAs("native");
  ctx.tools.register({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    output: { schema: {}, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (exec.agent?.id !== connection.session || !exec.callId) throw new Error("This tool belongs to a different chat turn.");
      const response = await fetch(connection.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.token}` },
        body: JSON.stringify({ sessionId: connection.session, callId: exec.callId, arguments: args }),
        signal: exec.signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error("Bowerbird chat tool connection is no longer available.");
      return response.json();
    },
  });
  // A preset is the agent's ancestor scope: restrict inherited tools on the agent,
  // after this preset's own tool is registered and before its first model request.
  ctx.on("agent/created", ({ agent }) => {
    if (agent.id === connection.session) agent.ctx.tools.restrict({ allow: [tool.name] });
  });
}
