/** Only cache misses enter this queue. Visible work precedes nearby prefetch;
 * releasing a subscription removes work that has not started yet. */
export function createFilePreviewQueue(load: (path: string) => Promise<string>, concurrency = 4) {
  type Listener = { priority: number; done: (path: string) => void };
  type Job = { key: string; path: string; listeners: Set<Listener>; started: boolean };
  const jobs = new Map<string, Job>();
  const cache = new Map<string, string>();
  let active = 0;
  let scheduled = false;
  function remember(key: string, path: string) {
    cache.delete(key); cache.set(key, path);
    if (cache.size > 512) cache.delete(cache.keys().next().value!);
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  }
  function pump() {
    while (active < concurrency) {
      const job = [...jobs.values()].filter(job => !job.started && job.listeners.size)
        .sort((a, b) => Math.min(...[...a.listeners].map(l => l.priority)) - Math.min(...[...b.listeners].map(l => l.priority)))[0];
      if (!job) return;
      job.started = true; active++;
      void Promise.resolve().then(() => load(job.path)).then(path => {
        remember(job.key, path);
        for (const listener of job.listeners) listener.done(path);
      }).catch(() => { /* A failed item never blocks the remainder of the directory. */ })
        .finally(() => { jobs.delete(job.key); active--; schedule(); });
    }
  }
  return {
    peek: (key: string) => cache.get(key),
    remember,
    forget: (key: string) => cache.delete(key),
    request(key: string, path: string, priority: number, done: (path: string) => void) {
      let job = jobs.get(key);
      if (!job) { job = { key, path, listeners: new Set(), started: false }; jobs.set(key, job); }
      const listener = { priority, done };
      job.listeners.add(listener); schedule();
      return {
        priority(value: number) { listener.priority = value; schedule(); },
        cancel() {
          job.listeners.delete(listener);
          if (!job.started && !job.listeners.size && jobs.get(key) === job) jobs.delete(key);
        },
      };
    },
  };
}
