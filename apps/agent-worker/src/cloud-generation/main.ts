import { configFromEnv, runGenerationWorker } from "./runtime.ts";

runGenerationWorker(configFromEnv(process.env)).catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "worker_failed";
  console.error(JSON.stringify({ event: "generation_worker_fatal", error: code }));
  process.exitCode = 1;
});
