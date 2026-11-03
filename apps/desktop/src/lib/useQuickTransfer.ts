import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { acceptQuickTransferSnapshot, EMPTY_QUICK_TRANSFER, type QuickTransferSnapshot } from "./quickTransferState";
import { userErrorMessage } from "./userError";

function observeQuickTransfer(accept: (snapshot: QuickTransferSnapshot) => void, onReady: (ready: boolean) => void, onError: (message: string) => void) {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void (async () => {
    try {
      // Register before querying; the revision guard also protects a late initial reply.
      const remove = await listen<QuickTransferSnapshot>("quick-transfer://changed", event => {
        if (!disposed) accept(event.payload);
      });
      if (disposed) { remove(); return; }
      unlisten = remove;
      const state = await invoke<QuickTransferSnapshot>("quick_transfer_status");
      if (!disposed) { accept(state); onReady(true); }
    } catch (error) {
      if (!disposed) onError(userErrorMessage(error, "暂时无法读取快传状态，请重新读取。"));
    }
  })();
  return () => { disposed = true; unlisten?.(); };
}

export function useQuickTransfer() {
  const [snapshot, setSnapshot] = useState(EMPTY_QUICK_TRANSFER);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [connection, setConnection] = useState(0);
  const pending = useRef(false);
  const accept = useCallback((incoming: QuickTransferSnapshot) => {
    setSnapshot(current => acceptQuickTransferSnapshot(current, incoming));
  }, []);

  useEffect(() => {
    setReady(false);
    setError("");
    return observeQuickTransfer(accept, setReady, setError);
  }, [accept, connection]);

  async function run(command: string, args: Record<string, unknown> | undefined, fallback: string) {
    if (pending.current || !ready) return;
    pending.current = true;
    setBusy(command);
    setError("");
    try {
      accept(await invoke<QuickTransferSnapshot>(command, args));
    } catch (error) {
      setError(userErrorMessage(error, fallback));
      // A command error alone cannot prove that the receiver stopped or never started.
      try { accept(await invoke<QuickTransferSnapshot>("quick_transfer_status")); } catch { setReady(false); }
    } finally {
      pending.current = false;
      setBusy("");
    }
  }

  return {
    snapshot, ready, busy, error,
    reconnect: () => setConnection(value => value + 1),
    start: (directory: string, address: string) => run("quick_transfer_start", { directory, address }, "未能开启接收，请检查所选文件夹和网络后重试。"),
    stop: () => run("quick_transfer_stop", undefined, "暂时无法确认接收已关闭，请查看状态后重试。"),
    retry: (id: string) => run("quick_transfer_retry", { id }, "文件仍保留在接收目录中，请稍后重试入库。"),
  };
}
