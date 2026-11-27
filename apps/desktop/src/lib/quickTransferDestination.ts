import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { userErrorMessage } from "./userError";
import { api } from "./api";
import { folderConnections, type FolderConnection } from "./folderConnections";
import {
  initialQuickTransferDestination, quickTransferDestinationKey,
  type QuickTransferDestination, type QuickTransferLocation,
} from "./quickTransferState";

type DefaultDestination = {
  builtin: QuickTransferLocation;
  effective: QuickTransferLocation;
  savedFolder: { folderId: string; name: string; path: string } | null;
  warning: string | null;
};

type DestinationOptions = {
  defaults: DefaultDestination;
  projects: Awaited<ReturnType<typeof api.listProjects>>;
  folders: FolderConnection[];
};

export function useQuickTransferDestinations(enabled: boolean, projectId: string | null) {
  const [options, setOptions] = useState<DestinationOptions | null>(null);
  const [selected, setSelected] = useState<QuickTransferDestination>({ kind: "default" });
  const [preview, setPreview] = useState<QuickTransferLocation | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);
  const defaultRevision = useRef(0);
  useEffect(() => {
    let disposed = false;
    setOptions(null);
    setPreview(null);
    setLoadError("");
    setActionError("");
    if (!enabled) return;
    void (async () => {
      try {
        const revision = defaultRevision.current;
        const [defaults, projects, folders] = await Promise.all([
          invoke<DefaultDestination>("quick_transfer_default_destination"),
          api.listProjects(),
          folderConnections.list(),
        ]);
        if (disposed) return;
        const currentDefaults = revision === defaultRevision.current
          ? defaults : await invoke<DefaultDestination>("quick_transfer_default_destination");
        if (disposed) return;
        setSelected(initialQuickTransferDestination(projectId, projects, currentDefaults.effective));
        setOptions({ defaults: currentDefaults, projects, folders });
      } catch (error) {
        if (!disposed) setLoadError(userErrorMessage(error, "暂时无法读取接收落点，请重新打开快传。"));
      }
    })();
    return () => { disposed = true; };
  }, [enabled, projectId]);

  const defaults = options?.defaults;
  const selectedKey = quickTransferDestinationKey(selected);
  const fromDefaults = selected.kind === "default" ? defaults?.builtin
    : defaults && quickTransferDestinationKey(defaults.effective) === selectedKey ? defaults.effective : undefined;
  useEffect(() => {
    let disposed = false;
    setPreview(null);
    if (enabled && defaults && !fromDefaults) {
      void invoke<QuickTransferLocation>("quick_transfer_preview_destination", { destination: selected })
        .then(location => { if (!disposed) setPreview(location); })
        .catch(error => {
          if (!disposed) setActionError(userErrorMessage(error, "无法使用此接收落点，请重新选择。"));
        });
    }
    return () => { disposed = true; };
  }, [enabled, defaults, fromDefaults, selected]);

  function select(target: QuickTransferDestination) {
    setActionError("");
    setSelected(target);
  }

  async function saveDefault(folderId: string | null) {
    setSaving(true);
    setActionError("");
    try {
      const updated = await invoke<DefaultDestination>("quick_transfer_set_default_folder", { folderId });
      defaultRevision.current++;
      setOptions(current => current && { ...current, defaults: updated });
      if (!folderId) {
        setSelected(current => current.kind === "folder" && current.folderId === defaults?.savedFolder?.folderId
          ? { kind: "default" } : current);
      }
    } catch (error) {
      setActionError(userErrorMessage(error, "未能更新默认接收文件夹，请重试。"));
    } finally {
      setSaving(false);
    }
  }

  return {
    options, selected, selectedKey, select, saving, saveDefault,
    location: enabled && options ? fromDefaults ?? (preview && quickTransferDestinationKey(preview) === selectedKey ? preview : null) : null,
    error: loadError || actionError,
  };
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
