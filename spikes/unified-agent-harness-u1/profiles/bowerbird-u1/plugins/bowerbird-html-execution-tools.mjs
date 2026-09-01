import { defineTool } from "@deepseek-ai/dsh-tools";
import { callBowerbirdPlanningBridge } from "./bowerbird-planning-rpc.mjs";

const JSON_OUTPUT = {
  schema: { type: "json" },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
};

function remoteTool({ name, description, parameters, conclude = false }) {
  return defineTool({
    name,
    description,
    parameters,
    output: JSON_OUTPUT,
    async execute(args, exec) {
      try {
        const value = await callBowerbirdPlanningBridge(name, args, exec.signal);
        if (conclude) exec.concludeTurn();
        return value;
      } catch (error) {
        // Approved slots are immutable: a failed compose/render/inspect/finalize call cannot be
        // repaired by changing arguments inside the same approval, so stop the costly model loop.
        exec.concludeTurn();
        return { status: "failed", terminalReason: "tool_execution_failed" };
      }
    },
  });
}

export const name = "bowerbird-html-execution-tools";
export const inject = ["tools"];

export function htmlExecutionToolDefinitions() {
  return [
    remoteTool({
      name: "compose_html",
      description: "Commit one approved, offline HTML/CSS document. Resource ids must exactly match the parent-supplied ordered manifest. URLs, paths, scripts, SVG, HTML/CSS comments, viewport meta and meta tags other than charset are forbidden.",
      parameters: {
        schemaVersion: { type: "integer", required: true, const: 1 },
        html: { type: "string", required: true },
        resourceArtifactIds: { type: "array", required: true, items: { type: "string" } },
      },
    }),
    remoteTool({
      name: "render_html",
      description: "Render the already committed HTML with parent-owned viewport, capture and resource settings. Takes no arguments.",
      parameters: {},
    }),
    remoteTool({
      name: "inspect_artifact",
      description: "Inspect the parent-selected rendered result with Bowerbird Ark Vision. Artifact identity, hash and inspection goal are parent-owned. Takes no arguments.",
      parameters: {},
    }),
    remoteTool({
      name: "finalize_output",
      description: "Signal completion with the parent-selected primary and visible artifacts. Takes no arguments and ends the approved execution turn.",
      parameters: {},
      conclude: true,
    }),
  ];
}

export function apply(ctx) {
  for (const definition of htmlExecutionToolDefinitions()) ctx.tools.register(definition);
}
