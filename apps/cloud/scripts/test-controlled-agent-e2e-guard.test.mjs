import { equal, match } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function run(name, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url)), ...args], {
    encoding: "utf8", windowsHide: true,
    // Malformed credentials would throw if a retired script tried reading them.
    env: { ...process.env, SUPABASE_PUBLISHABLE_KEYS: "invalid-json", ...extraEnv },
  });
}

for (const name of ["test-controlled-agent-e2e.mjs", "test-agent-control-plane.mjs"]) {
  test(name + " help is side-effect free", () => {
    const result = run(name, ["--help"]);
    equal(result.status, 0);
    match(result.stdout, /已退役/);
  });
  test(name + " refuses even with old provider gates enabled", () => {
    const result = run(name, ["--runtime", "dsh", "--allow-real-provider-costs"], {
      BOWERBIRD_U4_ALLOW_REAL_PROVIDER_COSTS: "1",
    });
    equal(result.status, 2);
    match(result.stderr, /已退役/);
  });
}

test("remote smoke rejects obsolete and misspelled skills before reading credentials", () => {
  for (const skill of ["--skill=controlled", "--skill=typo", "--skill"]) {
    const result = run("test-agent-runtime-selection-remote.mjs", [
      "--allow-remote-control-plane-smoke", skill,
    ], { BOWERBIRD_U4_ALLOW_REMOTE_CONTROL_PLANE_SMOKE: "1" });
    equal(result.status, 2);
    match(result.stderr, /只允许 --skill=unified/);
  }
});
