import type { AgentControlClient } from "../control-plane/agent-control-client.ts";
import { canonicalJson } from "../kernel/tool-ledger.ts";
import { UNDERSTAND_ASSET_FOCUS, validateAssetUnderstanding, type AssetUnderstanding, type UnderstandAssetFocus } from "./understand-asset-tool.ts";
import type { HarnessModelToolCall } from "./unified-planning-tool-bridge.ts";
import type { ToolGatewayResult } from "./scoped-tool-gateway.ts";

export type VisualObservationReference = {
  assetId: string;
  imageSha256: string;
  focus: UnderstandAssetFocus;
  callId: string;
  summaryExcerpt: string;
};

/** Full observations already live in durable diagnostics. Checkpoints keep only scoped references. */
export class VisualObservationMemory {
  private references: VisualObservationReference[];
  private readonly values = new Map<string, AssetUnderstanding>();
  private saving: Promise<void> = Promise.resolve();

  private readonly options: {
    runId: string;
    leaseId: string;
    assets: readonly { artifactId: string; sha256: string }[];
    references?: VisualObservationReference[];
    control: Pick<AgentControlClient, "getArtifactByCall" | "downloadVerifiedJson">;
    save(references: VisualObservationReference[]): Promise<void>;
  };

  constructor(options: VisualObservationMemory["options"]) {
    this.options = options;
    this.references = (options.references ?? []).filter(ref =>
      options.assets.some(asset => asset.artifactId === ref.assetId && asset.sha256 === ref.imageSha256) &&
      UNDERSTAND_ASSET_FOCUS.includes(ref.focus) && /^[a-f0-9]{64}$/.test(ref.callId) &&
      typeof ref.summaryExcerpt === "string" && ref.summaryExcerpt.length <= 240);
  }

  catalog() {
    return this.references.map(ref => ({ ...ref, contextId: `vision:${ref.callId}:0`, cost: "cached; no provider call" }));
  }

  async remember(call: HarnessModelToolCall, result: ToolGatewayResult): Promise<void> {
    const args = call.arguments as { assetId: string; focus: UnderstandAssetFocus };
    const asset = this.options.assets.find(asset => asset.artifactId === args.assetId);
    if (!asset || !UNDERSTAND_ASSET_FOCUS.includes(args.focus) || !/^[a-f0-9]{64}$/.test(result.callId)) {
      throw new Error("visual_observation_identity_invalid");
    }
    const value = validateAssetUnderstanding(result.value, new Set([args.assetId]));
    const reference: VisualObservationReference = { assetId: asset.artifactId, imageSha256: asset.sha256,
      focus: args.focus, callId: result.callId, summaryExcerpt: value.summary.slice(0, 240) };
    const save = this.saving.then(async () => {
      const next = [...this.references.filter(ref => ref.assetId !== reference.assetId || ref.focus !== reference.focus), reference];
      await this.options.save(next);
      this.references = next;
      this.values.set(reference.callId, value);
    });
    this.saving = save;
    await save;
  }

  private async load(ref: VisualObservationReference): Promise<AssetUnderstanding> {
    const cached = this.values.get(ref.callId);
    if (cached) return cached;
    const artifact = await this.options.control.getArtifactByCall(this.options.runId, this.options.leaseId, ref.callId);
    if (artifact.role !== "diagnostic" || artifact.mime !== "application/json" || !artifact.url) {
      throw new Error("visual_observation_artifact_invalid");
    }
    const value = validateAssetUnderstanding(await this.options.control.downloadVerifiedJson(
      artifact.url, artifact.sha256, 64 * 1024), new Set([ref.assetId]));
    this.values.set(ref.callId, value);
    return value;
  }

  async replay(call: HarnessModelToolCall): Promise<ToolGatewayResult | undefined> {
    const args = call.arguments as { assetId?: unknown; focus?: unknown } | null;
    if (!args || Object.keys(args).sort().join(",") !== "assetId,focus") return undefined;
    const ref = this.references.find(ref => ref.assetId === args.assetId && ref.focus === args.focus);
    return ref ? { callId: ref.callId, value: await this.load(ref) } : undefined;
  }

  async readContext(call: HarnessModelToolCall): Promise<ToolGatewayResult | undefined> {
    if (call.toolName !== "read_context") return undefined;
    const args = call.arguments as { id?: unknown } | null;
    if (!args || typeof args.id !== "string" || !args.id.startsWith("vision:")) return undefined;
    const match = /^vision:([a-f0-9]{64}):(\d{1,3})$/.exec(args.id);
    const ref = Object.keys(args).join(",") === "id" && match ? this.references.find(ref => ref.callId === match[1]) : undefined;
    if (ref && match) {
      const text = canonicalJson(await this.load(ref));
      const page = Number(match[2]);
      if (page * 2000 < text.length) return { callId: args.id, value: {
        id: args.id, content: { format: "json-text-page", text: text.slice(page * 2000, (page + 1) * 2000),
          nextId: (page + 1) * 2000 < text.length ? `vision:${ref.callId}:${page + 1}` : null },
      } };
    }
    return { callId: "validation", value: { status: "retry_required", errorCode: "visual_observation_not_found",
      correction: "Choose a contextId from visualObservations. Cached observations require no new visual call." } };
  }
}
