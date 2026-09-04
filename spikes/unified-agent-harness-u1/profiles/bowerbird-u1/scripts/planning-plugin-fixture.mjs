import { callBowerbirdPlanningBridge } from "../plugins/bowerbird-planning-rpc.mjs";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

try {
  const request = JSON.parse(input);
  const value = await callBowerbirdPlanningBridge(
    request.toolName,
    request.arguments,
    AbortSignal.timeout(10_000),
  );
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "unknown" }));
  process.exitCode = 1;
}
