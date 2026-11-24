import type { DocumentValue } from './documentTypes';

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();

function startWorker() {
  const instance = new Worker(new URL('./documentSerialization.worker.ts', import.meta.url), { type: 'module' });
  instance.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.failed) request.reject(new Error('文档暂时无法转换为 Markdown。'));
    else request.resolve(data.result);
  };
  const discard = () => {
    instance.terminate();
    worker = undefined;
    for (const request of pending.values()) request.reject(new Error('文档后台保存暂时不可用，请重试。'));
    pending.clear();
  };
  instance.onerror = event => { event.preventDefault(); discard(); };
  instance.onmessageerror = discard;
  return instance;
}

export function serializeMarkdownInWorker(value: DocumentValue): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    worker ??= startWorker();
    pending.set(id, { resolve, reject });
    try { worker.postMessage({ id, value }); }
    catch (error) { pending.delete(id); reject(error); }
  });
}
