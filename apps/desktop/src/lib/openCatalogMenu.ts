import { announceContextMenu, subscribeContextMenuOpen } from "./contextMenuOwnership";
import { useStore } from "../store";

let latestRequest = 0;

export function openCatalogMenu<T>({ ids, hit, cached, keyOf, visible, lookup, inScope, present, failed }: {
  ids: readonly string[];
  hit: T;
  cached?: ReadonlyMap<string, T>;
  keyOf: (value: T) => string;
  visible: (value: T) => boolean;
  lookup: (ids: string[], isCurrent: () => boolean) => Promise<T[]>;
  inScope: () => boolean;
  present: (rows: T[]) => void;
  failed: (reason: unknown) => void;
}) {
  const request = ++latestRequest;
  const route = useStore.getState().projectRouteRevision;
  const hitId = keyOf(hit);
  const found = new Map<string, T>();
  const missing: string[] = [];
  for (const id of ids) {
    const row = id === hitId ? hit : cached?.get(id);
    if (!row) missing.push(id);
    else found.set(id, row);
  }
  const getTargets = () => ids.flatMap(id => {
    const row = found.get(id);
    return row && visible(row) ? [row] : [];
  });
  const scopeIsCurrent = () => {
    const state = useStore.getState();
    return request === latestRequest && route === state.projectRouteRevision && !state.projectRoutePending && inScope();
  };
  if (!scopeIsCurrent()) return;
  if (!missing.length) {
    present(getTargets());
    return;
  }

  announceContextMenu("catalog-menu-request");
  let cancelled = false;
  const isCurrent = () => !cancelled && scopeIsCurrent();
  const cancelOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
  const unsubscribe = subscribeContextMenuOpen(cancel);
  function cancel() {
    if (cancelled) return;
    cancelled = true;
    unsubscribe();
    window.removeEventListener("pointerdown", cancel, true);
    window.removeEventListener("wheel", cancel, true);
    window.removeEventListener("keydown", cancelOnEscape, true);
    window.removeEventListener("blur", cancel);
  }
  window.addEventListener("pointerdown", cancel, true);
  window.addEventListener("wheel", cancel, { capture: true, passive: true });
  window.addEventListener("keydown", cancelOnEscape, true);
  window.addEventListener("blur", cancel);
  void lookup(missing, isCurrent).then(rows => {
    if (!isCurrent()) return;
    cancel();
    for (const row of rows) found.set(keyOf(row), row);
    present(getTargets());
  }, reason => {
    if (isCurrent()) failed(reason);
  }).finally(cancel);
}
