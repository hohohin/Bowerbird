import tool from "./chat-card-tool.json" with { type: "json" };
import { callBowerbirdPlanningBridge } from "./bowerbird-planning-rpc.mjs";

export const name = "bowerbird-chat-cards";
export const inject = ["tools"];

export function apply(ctx) {
  ctx.tools.register({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    output: { schema: {}, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    execute: (args, exec) => callBowerbirdPlanningBridge(tool.name, { acpCallId: exec.callId, args }, exec.signal),
  });
}
