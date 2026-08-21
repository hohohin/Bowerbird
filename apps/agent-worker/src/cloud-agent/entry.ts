import { runControlledAgentWorker } from "./main.ts";

runControlledAgentWorker(process.env).catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "agent_worker_failed";
  console.error(JSON.stringify({ event: "agent_worker_fatal", error: code }));
  process.exitCode = 1;
});
