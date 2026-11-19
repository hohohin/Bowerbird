type Job = { source: string; format: "card" | "excerpt"; signal?: AbortSignal; done: (value: string) => void; fail: (error: unknown) => void };
const queue: Job[] = [];
let worker: Worker | undefined;
let current: Job | undefined;

async function fallback(job: Job) {
  try {
    const parser = await import("./documentPreview");
    job.done(job.format === "card" ? parser.documentReadingHtml(job.source) : parser.documentPreviewText(job.source, "markdown"));
  } catch (error) { job.fail(error); }
  finally { current = undefined; run(); }
}

function run() {
  if (current) return;
  let job = queue.shift();
  while (job?.signal?.aborted) { job.done(""); job = queue.shift(); }
  if (!job) return;
  current = job;
  try {
    worker ??= new Worker(new URL("./documentReading.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.failed) job.fail(new Error("文档预览未完成"));
      else job.done(data.result);
      current = undefined;
      run();
    };
    worker.onerror = event => { event.preventDefault(); worker?.terminate(); worker = undefined; void fallback(job); };
    worker.postMessage({ source: job.source, format: job.format });
  } catch { void fallback(job); }
}

/** One parser serves all visible cards. Check visibility before sending a queued document to the worker. */
export function requestDocumentReading(source: string, format: Job["format"], signal?: AbortSignal): Promise<string> {
  return new Promise((done, fail) => { queue.push({ source, format, signal, done, fail }); run(); });
}
