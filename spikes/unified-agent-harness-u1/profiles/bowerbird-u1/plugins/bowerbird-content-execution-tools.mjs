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
      } catch {
        exec.concludeTurn();
        return { status: "failed", terminalReason: "tool_execution_failed" };
      }
    },
  });
}

export const name = "bowerbird-content-execution-tools";
export const inject = ["tools"];

/** U5 capability profile: the U3 HTML chain plus one bounded channel-package compiler. */
export function contentExecutionToolDefinitions() {
  return [
    remoteTool({
      name: "compose_html",
      description: "Commit one approved, offline HTML/CSS document using the exact parent-supplied resource order.",
      parameters: {
        schemaVersion: { type: "integer", required: true, const: 1 },
        html: { type: "string", required: true },
        resourceArtifactIds: { type: "array", required: true, items: { type: "string" } },
      },
    }),
    remoteTool({
      name: "render_html",
      description: "Render the committed HTML with parent-owned settings. Takes no arguments.",
      parameters: {},
    }),
    remoteTool({
      name: "inspect_artifact",
      description: "Optionally inspect the parent-selected render with Bowerbird Ark Vision. Takes no arguments.",
      parameters: {},
    }),
    remoteTool({
      name: "compose_xiaohongshu",
      description: "Commit one review-only Xiaohongshu draft package. The parent owns image identity and order; imageNotes must contain one note per selected image. Do not claim publishing.",
      parameters: {
        schemaVersion: { type: "integer", required: true, const: 1 },
        title: { type: "string", required: true },
        body: { type: "string", required: true },
        tags: { type: "array", required: true, items: { type: "string" } },
        imageNotes: { type: "array", required: true, items: { type: "string" } },
      },
    }),
    remoteTool({
      name: "finalize_output",
      description: "Signal completion with the parent-selected package and images. Takes no arguments and ends the turn.",
      parameters: {},
      conclude: true,
    }),
  ];
}

export function apply(ctx) {
  for (const definition of contentExecutionToolDefinitions()) ctx.tools.register(definition);
}
