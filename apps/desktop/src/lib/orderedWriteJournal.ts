export interface OrderedWriteJournal {
  pending: Array<() => Promise<void>>;
  failure: unknown | null;
}

export function createOrderedWriteJournal(): OrderedWriteJournal {
  return { pending: [], failure: null };
}

/**
 * Drain writes strictly in enqueue order. A failed head remains in place and
 * blocks every newer write until an explicit retry, preventing stale state
 * from being replayed after a newer value has already reached persistence.
 */
export async function drainOrderedWriteJournal(
  journal: OrderedWriteJournal,
  retryBlocked: boolean,
) {
  if (journal.failure != null && !retryBlocked) return journal.failure;
  if (retryBlocked) journal.failure = null;
  while (journal.pending.length > 0) {
    const work = journal.pending[0];
    try {
      await work();
      journal.pending.shift();
    } catch (reason) {
      journal.failure = reason;
      return reason;
    }
  }
  return null;
}
