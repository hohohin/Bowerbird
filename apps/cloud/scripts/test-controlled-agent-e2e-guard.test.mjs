import { equal, match } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./test-controlled-agent-e2e.mjs", import.meta.url));

function run(args, allowEnv = false) {
  const env = { ...process.env };
  delete env.BOWERBIRD_U4_ALLOW_REAL_PROVIDER_COSTS;
  if (allowEnv) env.BOWERBIRD_U4_ALLOW_REAL_PROVIDER_COSTS = "1";
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env,
    windowsHide: true,
  });
}

test("real controlled E2E help is side-effect free", () => {
  const result = run(["--help"]);
  equal(result.status, 0);
  match(result.stdout, /--runtime legacy_kernel\|dsh/);
});

test("real controlled E2E requires an explicit runtime", () => {
  const result = run([]);
  equal(result.status, 2);
  match(result.stderr, /不允许隐式默认运行时/);
});

test("real controlled E2E requires both independent provider-cost gates", () => {
  const flagOnly = run(["--runtime", "dsh", "--allow-real-provider-costs"]);
  equal(flagOnly.status, 2);
  match(flagOnly.stderr, /真实 E2E 已拒绝/);

  const envOnly = run(["--runtime", "dsh"], true);
  equal(envOnly.status, 2);
  match(envOnly.stderr, /真实 E2E 已拒绝/);
});

test("recovery observation rejects flows with normal extra execution leases", () => {
  const result = run([
    "--runtime", "dsh",
    "--allow-real-provider-costs",
    "--expect-reclaim",
    "--retry-text", "retry",
  ], true);
  equal(result.status, 2);
  match(result.stderr, /只允许单次批准执行/);
});
