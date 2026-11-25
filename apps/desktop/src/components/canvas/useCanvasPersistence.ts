import { useEffect, useRef, useState } from "react";
import { createOrderedWriteJournal, drainOrderedWriteJournal } from "../../lib/orderedWriteJournal";
import { useLatestCallback } from "../../lib/useCanvasFrame";

export function useCanvasPersistence({
  reportError, clearError, prepareFlush, persistView,
}: {
  reportError: (error: unknown) => void;
  clearError: () => void;
  prepareFlush: () => void;
  persistView: () => Promise<void>;
}) {
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const writeJournalRef = useRef(createOrderedWriteJournal());
  const pending = useRef(0);
  const [savingVisible, setSavingVisible] = useState(false);
  const saveIndicator = useRef({ busy: false, timer: 0 });
  const setSaving = (busy: boolean) => {
    const indicator = saveIndicator.current;
    if (indicator.busy === busy) return;
    indicator.busy = busy;
    window.clearTimeout(indicator.timer);
    indicator.timer = window.setTimeout(() => setSavingVisible(busy), busy ? 250 : 350);
  };
  useEffect(() => () => window.clearTimeout(saveIndicator.current.timer), []);

  const beginWrite = useLatestCallback(() => {
    pending.current += 1;
    setSaving(true);
    return () => {
      pending.current -= 1;
      if (pending.current === 0) setSaving(false);
    };
  });
  function scheduleWriteDrain(retryBlocked: boolean) {
    const endWrite = beginWrite();
    const run = writeQueueRef.current
      .then(async () => {
        const failure = await drainOrderedWriteJournal(writeJournalRef.current, retryBlocked);
        if (failure != null) reportError(failure);
      })
      .finally(endWrite);
    writeQueueRef.current = run;
    return run;
  }

  const enqueueWrite = useLatestCallback((work: () => Promise<void>) => {
    writeJournalRef.current.pending.push(work);
    return scheduleWriteDrain(false);
  });
  const retryPendingWrites = useLatestCallback(async () => {
    if (writeJournalRef.current.pending.length === 0) return;
    await scheduleWriteDrain(true);
    if (writeJournalRef.current.failure != null) throw writeJournalRef.current.failure;
    clearError();
  });
  const flushCanvasWrites = useLatestCallback(async (includeView: boolean) => {
    prepareFlush();
    await writeQueueRef.current;
    await retryPendingWrites();
    if (includeView) {
      await persistView();
      await writeQueueRef.current;
      await retryPendingWrites();
    }
  });
  const flushDetachedView = useLatestCallback((write: () => Promise<void>) =>
    writeQueueRef.current.then(async () => {
      const failure = await drainOrderedWriteJournal(writeJournalRef.current, true);
      if (failure == null) await write();
    }));
  return { writeQueueRef, writeJournalRef, savingVisible, beginWrite, enqueueWrite, retryPendingWrites, flushCanvasWrites, flushDetachedView };
}
