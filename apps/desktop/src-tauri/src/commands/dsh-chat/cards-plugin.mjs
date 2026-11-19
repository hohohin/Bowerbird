import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "bowerbird-chat-cards";
export const inject = ["tools"];

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "create_canvas_cards",
    description: "Create canvas cards and sections only when requested. The application validates the canonical card contract. Never starts generation.",
    // DSH's typed schema supports a JSON subset. The existing Cloud schema and
    // native card compiler remain authoritative for every card and section.
    parameters: {
      cards: { type: "array", items: { type: "json" }, required: true },
      connections: { type: "array", items: { type: "json" } },
      sections: { type: "array", items: { type: "json" } },
    },
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const response = await fetch(`${process.env.BOWERBIRD_DSH_ENDPOINT}/tool`, {
        method: "POST", signal: exec.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.BOWERBIRD_DSH_CAPABILITY}` },
        body: JSON.stringify({ id: exec.callId, name: "create_canvas_cards", args }),
      });
      if (!response.ok) throw new Error("DSH_CARD_BRIDGE_FAILED");
      return response.json();
    },
  }));
}
