import { defineTool } from "@deepseek-ai/dsh-tools";
import { callBowerbirdPlanningBridge, isRetryableComposeValidationError } from "./bowerbird-planning-rpc.mjs";

const JSON_OUTPUT = {
  schema: { type: "json" },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
};

function remoteTool({ name, description, parameters, conclude = false, nextRequiredTool }) {
  let composeValidationRetries = 0;
  let completed = false;
  return defineTool({
    name,
    description,
    parameters,
    output: JSON_OUTPUT,
    async execute(args, exec) {
      if (completed && nextRequiredTool) {
        return {
          status: "already_committed",
          nextRequiredTool,
          instruction: `${name} already succeeded and is immutable. Call ${nextRequiredTool} now; do not call ${name} again.`,
        };
      }
      try {
        const value = await callBowerbirdPlanningBridge(name, args, exec.signal);
        if (nextRequiredTool) {
          completed = true;
          return {
            ...value,
            nextRequiredTool,
            instruction: `${name} succeeded and is immutable. Call ${nextRequiredTool} now.`,
          };
        }
        if (conclude) exec.concludeTurn();
        return value;
      } catch (error) {
        if (composeValidationRetries < 2 && isRetryableComposeValidationError(name, error)) {
          composeValidationRetries += 1;
          return {
            status: "retry_required",
            correction: "The parent validator rejected compose_html. Copy every string in requiredExactCopyLines exactly into visible body text, including separators such as ——; one source line may wrap visually but must remain one contiguous text sequence. Also restore schemaVersion: 1, remove every HTML/CSS comment token (<!--, -->, /*, */), keep only allowed tags and attributes, and preserve resourceArtifactIds plus asset:reference-N aliases. Then call compose_html again before any other tool.",
          };
        }
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
      description: "Commit one approved, offline HTML/CSS document. For exact-copy delivery, copy every requiredExactCopyLines string with every punctuation mark into contiguous visible body text. Echo raw artifact ids only in resourceArtifactIds. Inside HTML, reference resources only as asset:reference-1, asset:reference-2, and so on in manifest order; never put a raw artifact id after asset:. The HTML string must contain none of <!--, -->, /*, or */.",
      parameters: {
        schemaVersion: { type: "integer", required: true, const: 1 },
        html: { type: "string", required: true, description: "Final comment-free offline HTML. Literal <!--, -->, /*, and */ tokens are forbidden." },
        resourceArtifactIds: { type: "array", required: true, description: "Exact ordered raw artifact ids supplied by the parent. These ids must not be used as HTML asset: URLs.", items: { type: "string" } },
      },
      nextRequiredTool: "render_html",
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
