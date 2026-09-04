/**
 * U4 test-only DSH side of the frozen 18-case controlled-image-edit eval.
 * Requires two explicit real-provider gates and never calls Ark or image generation.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DshAcpHarnessAdapter } from "../harness/dsh-acp-harness-adapter.ts";
import { NodeDshAcpPort } from "../harness/node-dsh-acp-port.ts";
import { deepSeekConfigFromEnv } from "../providers/deepseek/backend.ts";
import { DshModelBackend } from "../providers/deepseek/dsh-model-backend.ts";
import {
  renderControlledEvalMarkdown,
  summarizeControlledEval,
  type ControlledEvalRow,
} from "./controlled-image-edit-report.ts";
import { EvalMeteredProxyControl } from "./memory-metered-proxy-control.ts";
import {
  controlledEvalCases,
  runKernelCase,
  runModelCase,
  safeFailure,
  safeFailureDiagnostic,
} from "./run-controlled-image-edit-eval.ts";

const REAL_DSH_EVAL_FLAG = "--allow-real-u4-dsh-eval";
const DSH_MODEL = "deepseek-v4-flash";

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name}_missing`);
  return value;
}

export async function runControlledImageEditDshEval(options: {
  argv?: string[];
  env?: Record<string, string | undefined>;
} = {}): Promise<void> {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  if (!argv.includes(REAL_DSH_EVAL_FLAG)) throw new Error("real_u4_dsh_eval_flag_required");
  if (env.BOWERBIRD_U1_ALLOW_NETWORK !== "1") throw new Error("BOWERBIRD_U1_ALLOW_NETWORK_required");

  const profileTemplateDir = required(env, "BOWERBIRD_DSH_PROFILE_TEMPLATE");
  const runtimeRoot = required(env, "BOWERBIRD_DSH_RUNTIME_ROOT");
  const config = deepSeekConfigFromEnv(env);
  if (config.model !== DSH_MODEL) throw new Error("BOWERBIRD_CONTROLLED_IMAGE_EDIT_DSH_MODEL_mismatch");
  const control = new EvalMeteredProxyControl();
  const rows: ControlledEvalRow[] = [];
  const observations = [];
  const debugErrors = env.CONTROLLED_EVAL_DEBUG_ERRORS === "1";

  for (const testCase of controlledEvalCases(env)) {
    const runId = `eval-${testCase.id}`;
    const startedAt = Date.now();
    const row = testCase.mode === "model"
      ? await runModelCase(testCase, new DshModelBackend({
          runId,
          leaseId: `lease-${testCase.id}`,
          control,
          upstream: config,
          createAdapter(childEnvironment, providerEnvironment) {
            return new DshAcpHarnessAdapter({
              cwd: runtimeRoot,
              createPort: () => NodeDshAcpPort.create({
                profileTemplateDir,
                runtimeRoot,
                childEnvironment,
                providerEnvironment,
                parentEnvironment: env,
                profileMode: "controlled-model",
              }),
            });
          },
        }), {
          onFailure(error) {
            if (debugErrors) console.error(`[${testCase.id}:debug] ${safeFailureDiagnostic(error)}`);
          },
        })
      : await runKernelCase(testCase);
    const durationMs = Date.now() - startedAt;
    const usage = control.usageForRun(runId);
    row.promptTokens = usage.promptTokens;
    row.completionTokens = usage.completionTokens;
    // DSH may need one corrective internal model request before it emits the single
    // ModelBackend action. Count actual proxy requests, then add the same planned
    // image-tool estimate used by the legacy eval.
    row.estimatedCredits = usage.calls + row.steps * 5;
    rows.push(row);
    if (debugErrors && !row.structuredSuccess) {
      console.error(`[${row.id}:ledger] ${JSON.stringify(control.safeFailuresForRun(runId))}`);
    }
    observations.push({
      caseId: row.id,
      runtime: "dsh" as const,
      strategyCorrect: row.strategyCorrect,
      structuredSuccess: row.structuredSuccess,
      durationMs,
      credits: row.estimatedCredits,
      recoverySuccess: null,
      costBasis: "estimated" as const,
    });
    console.log(`[${row.id}] ${row.structuredSuccess ? "ok" : "FAIL"} ${row.outcome}${row.failureCode ? ` ${row.failureCode}` : ""}`);
  }

  const generatedAt = new Date().toISOString();
  const summary = summarizeControlledEval(rows);
  const artifactsDir = join(import.meta.dirname, "..", "..", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, "controlled-image-edit-eval-dsh.json"), JSON.stringify({
    generatedAt,
    runtime: "dsh",
    model: config.model,
    summary,
    rows,
  }, null, 2), "utf8");
  writeFileSync(join(artifactsDir, "controlled-image-edit-eval-dsh.md"),
    renderControlledEvalMarkdown(rows, generatedAt, `${config.model} / dsh`), "utf8");
  writeFileSync(join(artifactsDir, "controlled-runtime-observations-dsh.json"), JSON.stringify({
    generatedAt,
    model: config.model,
    observations,
  }, null, 2), "utf8");
  console.log(`report=${join(artifactsDir, "controlled-image-edit-eval-dsh.md")}`);
  if (summary.structuredSuccessRate < 1 || summary.toolPrivilegeViolationRate > 0) process.exitCode = 1;
}

if ((process.argv[1] ?? "").replaceAll("\\", "/").split("/").at(-1) === "run-controlled-image-edit-dsh-eval.ts") {
  runControlledImageEditDshEval().catch((error: unknown) => {
    console.error(safeFailure(error));
    process.exitCode = 1;
  });
}
