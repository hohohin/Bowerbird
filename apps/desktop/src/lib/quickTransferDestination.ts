import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { userErrorMessage } from "./userError";

export function useQuickTransferDirectory(visible: boolean, onError: (message: string) => void) {
  const [directory, setDirectory] = useState("");
  useEffect(() => {
    let disposed = false;
    if (visible) void invoke<string>("quick_transfer_directory")
      .then(path => { if (!disposed) setDirectory(path); })
      .catch(error => { if (!disposed) onError(userErrorMessage(error, "暂时无法读取资料目录，请重新打开快传。")); });
    return () => { disposed = true; };
  }, [visible, onError]);
  return directory;
}

export function useQuickTransferAddresses(visible: boolean, onError: (message: string) => void) {
  const [addresses, setAddresses] = useState<string[]>([]);
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  useEffect(() => { if (visible) void refresh(); }, [visible]);
  useEffect(() => () => { ++sequence.current; }, []);

  async function refresh() {
    const request = ++sequence.current;
    setLoading(true);
    onError("");
    try {
      const found = await invoke<string[]>("quick_transfer_addresses");
      if (request !== sequence.current) return;
      setAddresses(found);
      setAddress(current => found.includes(current) ? current : found[0] ?? "");
    } catch (error) {
      if (request === sequence.current) {
        setAddresses([]);
        setAddress("");
        onError(userErrorMessage(error, "暂时无法读取局域网地址，请检查网络后刷新。"));
      }
    } finally { if (request === sequence.current) setLoading(false); }
  }
  return { addresses, address, loading, setAddress, refresh };
}
