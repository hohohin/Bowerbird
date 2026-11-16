import type { AppSettings } from "./types";

type Patch = Partial<AppSettings>;
type Failure = { patch: Patch; cause: unknown };

// Native persistence accepts a full snapshot. Serialize reads and writes and
// derive each snapshot from the last successful operation and its field patch.
export function settingsQueue(read: () => Promise<AppSettings>, write: (value: AppSettings) => Promise<void>,
  current: () => AppSettings | null, publish: (value: AppSettings | null, failure: Failure | null) => void) {
  let tail = Promise.resolve();
  let confirmed: AppSettings | null = null;
  let failure: Failure | null = null;
  const pending = new Set<Patch>();
  function display() {
    const base = confirmed ?? current();
    publish(base && Object.assign({}, base, ...pending), failure);
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
        await write(next);
        confirmed = next;
      } catch (cause) {
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
    retry: () => failure ? update({ ...failure.patch }) : Promise.resolve(),
  };
}
