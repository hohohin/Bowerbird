import type { AppSettings, SettingsSaveReceipt } from "./types";

type Patch = Partial<AppSettings>;
type Failure = { patch: Patch; cause: unknown };
const SEMANTIC_SETTINGS = [
  "semantic_index_automatic",
  "semantic_index_interval_minutes",
  "semantic_index_include_generated",
] as const;
type SemanticSetting = typeof SEMANTIC_SETTINGS[number];

// Native persistence accepts a full snapshot. Serialize reads and writes and
// derive each snapshot from the last successful operation and its field patch.
export function settingsQueue(read: () => Promise<AppSettings>, write: (value: AppSettings, patch: Patch) => Promise<SettingsSaveReceipt | null | void>,
  current: () => AppSettings | null, publish: (value: AppSettings | null, failure: Failure | null) => void) {
  let tail = Promise.resolve();
  let confirmed: AppSettings | null = null;
  let failure: Failure | null = null;
  let semanticFailure: { keys: readonly SemanticSetting[]; cause: Error } | null = null;
  const pending = new Set<Patch>();
  function currentFailure(): Failure | null {
    if (!semanticFailure) return failure;
    const saved = confirmed ?? current();
    const retry = saved && Object.fromEntries(semanticFailure.keys.filter(key => key in saved).map(key => [key, saved[key]]));
    return {
      patch: { ...retry, ...failure?.patch },
      cause: failure?.cause ?? semanticFailure.cause,
    };
  }
  function display() {
    const base = confirmed ?? current();
    publish(base && Object.assign({}, base, ...pending), currentFailure());
  }
  function enqueue<T>(operation: () => Promise<T>) {
    const result = tail.then(operation);
    tail = result.then(() => {}, () => {});
    return result;
  }
  function update(patch: Patch) {
    if (!pending.size) confirmed = current();
    if (failure) {
      for (const key of Object.keys(patch) as (keyof Patch)[]) delete failure.patch[key];
      if (!Object.keys(failure.patch).length) failure = null;
    }
    pending.add(patch);
    display();
    return enqueue(async () => {
      try {
        confirmed ??= await read();
        const next = { ...confirmed, ...patch };
        const receipt = await write(next, patch);
        confirmed = next;
        if (receipt?.semanticIndexApplied === false) {
          const changed = SEMANTIC_SETTINGS.filter(key => key in patch || semanticFailure?.keys.includes(key));
          const message = receipt.semanticIndexError === "disk_full"
            ? "设置已保存。磁盘空间不足，请释放空间后重试应用索引设置。"
            : "已保存设置，暂未应用到索引。请重试。";
          semanticFailure = {
            keys: changed.length ? changed : SEMANTIC_SETTINGS,
            cause: Object.assign(new Error(message), { cause: receipt.semanticIndexError }),
          };
        } else if (receipt?.semanticIndexApplied === true) {
          semanticFailure = null;
        }
      } catch (cause) {
        console.error("settings.save_failed", { keys: Object.keys(patch), cause });
        const retry = { ...patch };
        for (const later of pending) if (later !== patch) {
          for (const key of Object.keys(later) as (keyof Patch)[]) delete retry[key];
        }
        if (Object.keys(retry).length) failure = { patch: { ...failure?.patch, ...retry }, cause };
        throw cause;
      } finally {
        pending.delete(patch);
        display();
      }
    });
  }
  return {
    update,
    load: () => enqueue(async () => { confirmed = await read(); display(); }),
    retry: () => {
      const last = currentFailure();
      if (!last) return Promise.resolve();
      const patch = { ...last.patch };
      for (const edit of pending) {
        for (const key of Object.keys(edit) as (keyof Patch)[]) delete patch[key];
      }
      return Object.keys(patch).length || !pending.size ? update(patch) : Promise.resolve();
    },
  };
}
