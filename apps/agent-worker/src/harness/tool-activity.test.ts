import { equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import { ToolActivity, withToolActivityTimeout } from "./tool-activity.ts";

test("tool wait and overlapping calls do not consume the model inactivity timeout", async () => {
  let now = 0;
  const activity = new ToolActivity(() => now);
  let first!: () => void, second!: () => void;
  const a = activity.run(() => new Promise<void>((resolve) => { first = resolve; }));
  const b = activity.run(() => new Promise<void>((resolve) => { second = resolve; }));
  now = 1_000_000;
  equal(activity.remaining(0, 600_000), 600_000);
  first(); await a;
  now += 1_000_000;
  equal(activity.remaining(0, 600_000), 600_000);
  second(); await b;
  now += 20;
  equal(activity.remaining(0, 600_000), 599_980);
  now += 600_000;
  equal(activity.remaining(0, 600_000), -20);
});

test("inactive ACP still times out and tool-aware timer stops after completion", async () => {
  await rejects(() => withToolActivityTimeout(new Promise<void>(() => {}), 15, new ToolActivity()), /dsh_acp_prompt_timeout/);
  const activity = new ToolActivity();
  const result = activity.run(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    return "done";
  });
  equal(await withToolActivityTimeout(result, 15, activity), "done");
});
