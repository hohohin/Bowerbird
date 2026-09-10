import type { HarnessModelToolCall } from "./unified-planning-tool-bridge.ts";
import type { ToolGatewayResult } from "./scoped-tool-gateway.ts";

export type RunContextResource = { id: string; description: string; read(): unknown };

/** Only explicitly registered, claim-bound resources are readable. No paths or URLs. */
export class RunContextTools {
  private readonly source: readonly RunContextResource[] | (() => readonly RunContextResource[]);

  constructor(resources: readonly RunContextResource[] | (() => readonly RunContextResource[])) {
    this.source = resources;
    this.resources();
  }

  private resources(): readonly RunContextResource[] {
    const resources = typeof this.source === "function" ? this.source() : this.source;
    if (new Set(resources.map((resource) => resource.id)).size !== resources.length) {
      throw new Error("run_context_duplicate_id");
    }
    return resources;
  }

  catalog(): Array<{ id: string; description: string }> {
    return this.resources().map(({ id, description }) => ({ id, description }));
  }

  dispatch(call: HarnessModelToolCall): ToolGatewayResult | undefined {
    if (call.toolName !== "read_context") return undefined;
    const args = call.arguments;
    const resource = args && typeof args === "object" && !Array.isArray(args) &&
      Object.keys(args).join(",") === "id"
      ? this.resources().find((entry) => entry.id === (args as { id?: unknown }).id) : undefined;
    if (!resource) return { callId: "validation", value: {
      status: "retry_required", errorCode: "run_context_not_found",
      correction: "Pass {id} using an id from availableContext.",
    } };
    return { callId: `context:${resource.id}`, value: {
      id: resource.id, content: resource.read(),
    } };
  }
}
