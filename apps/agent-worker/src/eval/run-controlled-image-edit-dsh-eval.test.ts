import { equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import { runControlledImageEditDshEval } from "./run-controlled-image-edit-dsh-eval.ts";
import { safeFailureDiagnostic } from "./run-controlled-image-edit-eval.ts";

test("U4 DSH eval requires both explicit provider gates before reading credentials", async () => {
  await rejects(() => runControlledImageEditDshEval({ argv: [], env: {} }),
    /real_u4_dsh_eval_flag_required/);
  await rejects(() => runControlledImageEditDshEval({
    argv: ["--allow-real-u4-dsh-eval"],
    env: {},
  }), /BOWERBIRD_U1_ALLOW_NETWORK_required/);
  await rejects(() => runControlledImageEditDshEval({
    argv: ["--allow-real-u4-dsh-eval"],
    env: { BOWERBIRD_U1_ALLOW_NETWORK: "1" },
  }), /BOWERBIRD_DSH_PROFILE_TEMPLATE_missing/);
});

test("U4 DSH eval diagnostic fingerprints errors without exposing raw messages", () => {
  const diagnostic = safeFailureDiagnostic(new Error(
    "HTTP 400 tool validation failed: controlled_plan_step_count_invalid secret-detail",
  ));
  const parsed = JSON.parse(diagnostic) as Record<string, unknown>;
  equal(parsed.name, "Error");
  equal(parsed.httpStatus, 400);
  equal((parsed.identifiers as string[])[0], "controlled_plan_step_count_invalid");
  equal(diagnostic.includes("secret-detail"), false);
});
