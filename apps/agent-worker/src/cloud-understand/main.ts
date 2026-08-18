import { configFromEnv, runUnderstandWorker } from "./runtime.ts";

runUnderstandWorker(configFromEnv(process.env)).catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "worker_failed";
  console.error(JSON.stringify({ event: "understand_worker_fatal", error: code }));
  process.exitCode = 1;
});
