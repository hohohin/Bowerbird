import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { userErrorMessage } from "./userError";

export function useQuickTransferDirectory(savedDirectory: string | null, blocked: boolean, onError: (message: string) => void) {
  const [directory, setDirectory] = useState("");
  const [choosing, setChoosing] = useState(false);
  const selecting = useRef(false);
  useEffect(() => { if (savedDirectory) setDirectory(savedDirectory); }, [savedDirectory]);

  async function choose() {
    if (selecting.current || blocked) return;
    selecting.current = true;
    setChoosing(true);
    onError("");
    try {
      const selected = await open({ directory: true, multiple: false, title: "选择快传接收文件夹", defaultPath: directory || undefined });
      if (typeof selected === "string") setDirectory(selected);
    } catch (error) { onError(userErrorMessage(error, "无法选择文件夹，请检查权限后重试。")); }
    finally { selecting.current = false; setChoosing(false); }
  }
  return { directory, choosing, choose };
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
