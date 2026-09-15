import { equal, deepEqual, ok, throws, rejects } from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentControlClient } from "../control-plane/agent-control-client.ts";
import type { AgentRunContext } from "./runtime.ts";
import type { HarnessPlan } from "../harness/run-control-tools.ts";
import { validateHarnessPlan } from "../harness/run-control-tools.ts";
import { canonicalJson, sha256Hex } from "../kernel/tool-ledger.ts";
import { UnifiedPlanningRunProcessor } from "./unified-planning-run-processor.ts";
import type { ClarificationProposal } from "../contracts/clarification.ts";

function plan(sections = 13): HarnessPlan {
  return {
    schemaVersion: 2, title: "无参考图创作", summary: "按用户目标生成视觉资产",
    contentPlan: { assetAssignments: [], visualProfile: null, missingAssets: [],
      informationArchitecture: Array.from({ length: sections }, (_, index) => ({
        id: `section-${index}`, purpose: "内容区块", sourceAssetIds: [], copySource: "user_goal" as const,
      })) },
    steps: [
      { id: "generate", kind: "generate_image", goal: "生成蓝色主视觉", inputAssetIds: [], dependsOn: [] },
      { id: "final", kind: "finalize_output", goal: "交付图片", inputAssetIds: [], dependsOn: ["generate"] },
    ],
  };
}

test("13 sections and zero source assets are valid; section ceiling is independent of tool steps", () => {
  equal(validateHarnessPlan(plan()).schemaVersion, 2);
  equal(validateHarnessPlan(plan(64)).steps.length, 2);
  throws(() => validateHarnessPlan(plan(65)), /plan_content_invalid/);
});

for (const clarify of [false, true]) test(`unified Agent ${clarify ? "clarifies then" : "directly"} plans, revises, reapproves and finishes`, async () => {
  const claim: AgentRunContext["claimed"] = {
    run: { id: `run-${randomUUID()}`, conversationId: "conversation", skillId: "bowerbird-unified-agent", skillVersion: "0.1.0",
      inputManifestHash: "a".repeat(64), approvedPlanHash: null, plannedToolCount: null, resultFeedbackAction: null,
      budgetCredits: 100, pricingVersion: 1, checkpointHash: null, snapshotSchemaVersion: null },
    lease: { leaseId: "lease", leaseSeconds: 60 }, inputUrl: "https://local.invalid/input", artifactUrls: [],
  };
  let checkpoint: Uint8Array | null = null;
  let approved = plan();
  let question: ClarificationProposal | undefined;
  let responseBody: unknown;
  const approvalCalls: string[] = [];
  const imageCalls: string[] = [];
  const eventSeqs: number[] = [];
  let finished = false;
  let environment: Readonly<Record<string, string>>;
  const control = {
    async loadRawCheckpoint() { return checkpoint; },
    async downloadVerifiedJson(url: string) { return url.endsWith("input") ? { schemaVersion: 1, goal: "设计海报" } : approved; },
    async download() { return new TextEncoder().encode(JSON.stringify(responseBody)); },
    async saveRawCheckpoint(args: { bytes: Uint8Array; sha256: string }) {
      checkpoint = args.bytes; claim.run.checkpointHash = args.sha256; claim.run.snapshotSchemaVersion = 1;
    },
    async appendEvents(_run: string, _lease: string, events: Array<{ seq: number }>) { eventSeqs.push(...events.map((event) => event.seq)); },
    async requestUnifiedPlanApproval(args: { callId: string; proposal: HarnessPlan; proposalHash: string }) {
      approvalCalls.push(args.callId); approved = args.proposal;
      claim.run.approvedPlanHash = args.proposalHash; claim.run.plannedToolCount = approved.steps.length;
      claim.approvedPlan = { proposalHash: args.proposalHash, plannedToolCount: approved.steps.length, url: "https://local.invalid/plan" };
      return { status: "awaiting_approval", proposalHash: args.proposalHash, reused: false, estimatedAdditionalCredits: 5 };
    },
    async requestClarification(args: { proposal: ClarificationProposal }) { question = args.proposal; },
    async awaitResultFeedback() {},
    async finish() { finished = true; },
  } as unknown as AgentControlClient;
  const call = async (toolName: string, args: unknown): Promise<any> => {
    const response = await fetch(environment.BOWERBIRD_TOOL_BRIDGE_ENDPOINT!, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${environment.BOWERBIRD_TOOL_BRIDGE_CAPABILITY}` },
      body: JSON.stringify({ toolName, arguments: args }),
    });
    equal(response.status, 200);
    return (await response.json() as { value: unknown }).value;
  };
  let planningTurns = 0;
  const processor = new UnifiedPlanningRunProcessor({
    workspaceRoot: join(process.env.TEMP ?? ".", "bowerbird-unified-tests", randomUUID()),
    vision: { apiKey: "unused", baseUrl: "https://ark.invalid", model: "unused", mock: true },
    createAdapter(env) {
      environment = env;
      return { id: "fixture", async open(seed) {
        return { sessionId: "session", runId: seed.runId, async cancel() {}, async close() {},
          async turn(blocks) {
            planningTurns++;
            const skills = await call("list_skills", {});
            ok(skills.some((entry: { id: string }) => entry.id === "bowerbird-controlled-image-edit"));
            const skill = await call("read_skill", { skillId: "bowerbird-controlled-image-edit" });
            ok(skill.instructions.length > 100);
            equal((await call("read_skill", { skillId: "../../secret" })).status, "retry_required");
            if (clarify && !question) {
              await call("ask_user", { question: "需要什么色调？", options: ["冷蓝", "暖红"] });
              return { stopReason: "end_turn", committedContent: [] };
            }
            const text = blocks[0]?.type === "text" ? blocks[0].text : "";
            if (clarify) ok(text.includes("冷蓝"));
            if (approvalCalls.length) ok(text.includes("颜色更浅"));
            const invalid = await call("submit_plan", { plan: plan(65) });
            equal(invalid.status, "retry_required"); ok(invalid.correction.includes("64"));
            // New plans need only executable steps, including for revisions.
            const { contentPlan: _content, ...minimal } = plan() as Extract<HarnessPlan, { schemaVersion: 2 }>;
            await call("submit_plan", { plan: { ...minimal, schemaVersion: 1 } });
            return { stopReason: "end_turn", committedContent: [] };
          } };
      } };
    },
    createApprovedStepExecutor() { return { async generate(request) {
      imageCalls.push(request.callId);
      return { artifactId: `result-${imageCalls.length}`, mime: "image/png", bytes: 42, sha256: "b".repeat(64) };
    } }; },
  });
  const context: AgentRunContext = { claimed: claim, control, signal: { aborted: false, cancelRequested: false, leaseLost: false, stopRequested: false } };
  await processor.process(context);
  if (clarify) {
    if (!question) throw new Error("question_missing");
    const originalQuestion = question;
    await processor.process(context);
    deepEqual(question, originalQuestion);
    equal(planningTurns, 1, "a saved pending question is re-parked without another model turn");
    const patch = { sourceQuestionKey: question.questionKey, contextHash: question.contextHash, patches: question.optionPatches[0]!.patches };
    responseBody = { answer: "冷蓝", intentPatch: patch };
    claim.clarificationAnswer = { questionKey: question.questionKey, contextHash: question.contextHash,
      intentPatchHash: sha256Hex(canonicalJson(patch)), url: "https://local.invalid/answer" };
    responseBody = { answer: "篡改的答案", intentPatch: patch };
    await rejects(() => processor.process(context), /unified_agent_clarification_answer_invalid/);
    responseBody = { answer: "冷蓝", intentPatch: patch };
    await processor.process(context);
  }
  equal(approvalCalls.length, 1);
  equal(approved.schemaVersion, 1);
  await processor.process(context);
  equal(imageCalls.length, 1);
  // The feedback API atomically clears old approval, retaining the Run and its ledger.
  claim.run.approvedPlanHash = null; claim.run.plannedToolCount = null; claim.run.resultFeedbackAction = "retry";
  claim.approvedPlan = null; claim.feedbackUrl = "https://local.invalid/feedback";
  responseBody = { action: "retry", text: "颜色更浅" };
  await processor.process(context);
  equal(approvalCalls.length, 2); ok(approvalCalls[0] !== approvalCalls[1]);
  await processor.process(context);
  equal(imageCalls.length, 2); ok(imageCalls[0] !== imageCalls[1]);
  claim.run.resultFeedbackAction = "accept";
  await processor.process(context);
  equal(finished, true);
  equal(planningTurns, clarify ? 3 : 2);
  deepEqual(eventSeqs, [...new Set(eventSeqs)], "revision events never overwrite previous rounds");
});
