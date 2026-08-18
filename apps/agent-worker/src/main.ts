// 组合入口：同一受限部署内的多个消费循环（G0 生图 + understand 队列；A2 Agent Run 同向扩展）。
// 各循环按其 CONTROL_URL 是否配置启用，互不阻塞；任一循环 fatal 不拖垮其它循环。
import { configFromEnv as generationConfigFromEnv, runGenerationWorker } from "./cloud-generation/runtime.ts";
import { configFromEnv as understandConfigFromEnv, runUnderstandWorker } from "./cloud-understand/runtime.ts";

let loops = 0;

function fatal(event: string): (error: unknown) => void {
  return (error: unknown) => {
    const code = error instanceof Error ? error.message : "worker_failed";
    console.error(JSON.stringify({ event, error: code }));
    process.exitCode = 1;
  };
}

if (process.env.GENERATION_CONTROL_URL?.trim()) {
  loops += 1;
  runGenerationWorker(generationConfigFromEnv(process.env)).catch(fatal("generation_worker_fatal"));
}

if (process.env.UNDERSTAND_CONTROL_URL?.trim()) {
  loops += 1;
  runUnderstandWorker(understandConfigFromEnv(process.env)).catch(fatal("understand_worker_fatal"));
}

if (!loops) {
  console.error(JSON.stringify({ event: "worker_noop", error: "GENERATION_CONTROL_URL/UNDERSTAND_CONTROL_URL_missing" }));
  process.exitCode = 1;
}
