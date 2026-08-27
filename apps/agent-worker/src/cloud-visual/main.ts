import { configFromEnv, runVisualProfileWorker } from "./runtime.ts";

runVisualProfileWorker(configFromEnv(process.env)).catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "worker_failed";
  console.error(JSON.stringify({ event: "visual_worker_fatal", error: code }));
  process.exitCode = 1;
});
