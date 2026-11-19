const callbacks = new WeakMap<object, (node: unknown) => void>();
/** Keep React 18 callback refs stable across selection and drag renders. */
export function bindRef<T>(ref: { current: T | null } | undefined) {
  if (!ref) return undefined;
  let callback = callbacks.get(ref);
  if (!callback) { callback = (node: unknown) => { ref.current = node as T | null; }; callbacks.set(ref, callback); }
  return callback;
}
