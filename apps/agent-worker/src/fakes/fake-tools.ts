/**
 * FakeTools —— 全局工具白名单的确定性假实现（M0 eval 专用）。
 *
 * 不调用方舟/网络/文件系统；用合成数据返回规范化结果。
 * 真实 Ark adapter / 工作区 IO 属于 A2/A3，不在 M0。
 *
 * 工具层防御：只认本 Run manifest 内的 assetId；read_input_manifest 无 runId 参数，
 * 跨 Run 读取在协议层不可表达（与 PolicyEngine 的白名单/跨 Run 守卫互为兜底）。
 */

import type { ProviderUsage } from "../contracts/model.ts";
import type { ToolErrorClass } from "../contracts/tools.ts";
import { sha256Hex } from "../kernel/tool-ledger.ts";

/** 本 Run 的输入 manifest（选中图 + 已有反推摘要；无图片字节）。 */
export type InputManifestEntry = {
  assetId: string;
  sourceClass: "imported" | "generated_confirmed" | "generated_other";
  sections: Array<{ title: string; body: string }>;
  dimensions: Record<string, string>;
};

export type FakeArtifact = {
  callId: string;
  kind: string;
  contentHash: string;
  summary: string;
  mime?: string;
  bytes?: number;
  sha256?: string;
};

export type FakeToolExec =
  | { ok: true; artifact?: FakeArtifact; usage: ProviderUsage; display: string }
  | { ok: false; errorClass: ToolErrorClass; safeCode: string };

export class FakeTools {
  private readonly manifest: Map<string, InputManifestEntry>;
  readonly artifacts = new Map<string, FakeArtifact>();
  /** 所有工具执行日志（含被工具层拒绝的），供 eval 断言。 */
  readonly log: Array<{ tool: string; args: unknown; result: FakeToolExec }> = [];

  constructor(entries: InputManifestEntry[]) {
    this.manifest = new Map(entries.map((e) => [e.assetId, e]));
  }

  private newArtifact(callId: string, kind: string, summary: string, content: string): FakeArtifact {
    const art: FakeArtifact = { callId, kind, contentHash: sha256Hex(content), summary };
    this.artifacts.set(callId, art);
    return art;
  }

  execute(callId: string, toolName: string, args: unknown): FakeToolExec {
    const a = (args ?? {}) as Record<string, unknown>;
    const rec = (result: FakeToolExec) => {
      this.log.push({ tool: toolName, args, result });
      return result;
    };

    switch (toolName) {
      case "read_input_manifest": {
        const entries = [...this.manifest.values()].map((e) => ({
          assetId: e.assetId,
          sourceClass: e.sourceClass,
          sections: e.sections,
          dimensions: e.dimensions,
        }));
        return rec({ ok: true, usage: {}, display: `${entries.length} inputs` });
      }
      case "understand_image": {
        const id = String(a["assetId"] ?? "");
        const entry = this.manifest.get(id);
        if (!entry) {
          return rec({ ok: false, errorClass: "policy_denied", safeCode: "asset_not_in_run" });
        }
        return rec({
          ok: true,
          usage: { totalTokens: 120 },
          display: `understood ${id}: ${entry.sections.length} sections`,
        });
      }
      case "parse_intent": {
        const intent = a["intent"] as object;
        const art = this.newArtifact(callId, "intent", "结构化意图", JSON.stringify(intent));
        return rec({ ok: true, artifact: art, usage: { totalTokens: 40 }, display: "intent parsed" });
      }
      case "assign_reference_roles": {
        const assignments = a["assignments"] as unknown[];
        const art = this.newArtifact(callId, "reference_roles", `${(assignments ?? []).length} 角色指派`, JSON.stringify(assignments));
        return rec({ ok: true, artifact: art, usage: { totalTokens: 30 }, display: "roles assigned" });
      }
      case "score_dimensions": {
        const scores = a["scores"] as unknown[];
        const art = this.newArtifact(callId, "score", `${(scores ?? []).length} 维度评分`, JSON.stringify(scores));
        return rec({ ok: true, artifact: art, usage: { totalTokens: 60 }, display: "scored" });
      }
      case "accept_result": {
        return rec({ ok: true, usage: {}, display: "accepted" });
      }
      case "generate_image":
      case "refine_once": {
        const prompt = String(a["prompt"] ?? "");
        const refs = (a["referenceAssetIds"] as string[] | undefined) ?? [];
        const sha = sha256Hex(`gen|${prompt}|${[...refs].sort().join(",")}`);
        const art = this.newArtifact(callId, "generated_image", `生成图 ${sha.slice(0, 8)}`, sha);
        art.mime = "image/png";
        art.bytes = 1;
        art.sha256 = sha;
        return rec({ ok: true, artifact: art, usage: { imageCount: 1, totalTokens: 0 }, display: `generated ${sha.slice(0, 8)}` });
      }
      case "inspect_generated_image": {
        const target = String(a["artifactCallId"] ?? "");
        const art = this.artifacts.get(target);
        if (!art || art.kind !== "generated_image") {
          return rec({ ok: false, errorClass: "policy_denied", safeCode: "artifact_not_in_run" });
        }
        return rec({ ok: true, usage: { totalTokens: 80 }, display: `inspected ${target}` });
      }
      case "write_artifact": {
        const kind = String(a["kind"] ?? "generic");
        const content = String(a["content"] ?? "");
        const art = this.newArtifact(callId, kind, kind, content);
        return rec({ ok: true, artifact: art, usage: {}, display: `wrote ${kind}` });
      }
      case "propose_preference": {
        const art = this.newArtifact(callId, "preference_candidate", "偏好候选", JSON.stringify(a["facts"] ?? []));
        return rec({ ok: true, artifact: art, usage: {}, display: "preference proposed" });
      }
      case "finish_run": {
        const ids = (a["artifactCallIds"] as string[] | undefined) ?? [];
        const missing = ids.filter((id) => !this.artifacts.has(id));
        if (missing.length) {
          return rec({ ok: false, errorClass: "validation_error", safeCode: "missing_artifacts" });
        }
        return rec({ ok: true, usage: {}, display: `finalized ${ids.length} artifacts` });
      }
      default:
        return rec({ ok: false, errorClass: "policy_denied", safeCode: "tool_not_implemented" });
    }
  }
}
