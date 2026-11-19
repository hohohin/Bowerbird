// Local display preferences. Task results and recovery state stay in their original stores.
const prefix = "bowerbird.dismissed-notices.v1:";
const cache = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();

function readStorage(scope: string): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(prefix + scope) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

export function readDismissedNotices(scope: string): ReadonlySet<string> {
  let keys = cache.get(scope);
  if (!keys) {
    keys = readStorage(scope);
    cache.set(scope, keys);
  }
  return keys;
}

export function dismissNotices(scope: string, keys: readonly string[]) {
  const previous = readDismissedNotices(scope);
  if (keys.every(key => previous.has(key))) return;
  const next = new Set([...readStorage(scope), ...previous, ...keys]);
  cache.set(scope, next);
  try { localStorage.setItem(prefix + scope, JSON.stringify([...next])); } catch { /* Keep the current window usable. */ }
  for (const listener of listeners) listener();
}

export function subscribeDismissedNotices(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key === null) cache.clear();
  else if (event.key.startsWith(prefix)) cache.delete(event.key.slice(prefix.length));
  else return;
  for (const listener of listeners) listener();
});
