import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { api } from "../lib/api";
import { notifyError } from "../lib/notify";
import { useStore } from "../store";

export function VisualProfileImportButton({ disabled = false, compact = false }: { disabled?: boolean; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  return <>
    <button type="button" disabled={disabled || busy} aria-busy={busy} aria-label="导入视觉规范"
      title="导入别人分享的视觉规范，查看并保存后使用"
      className={compact ? "flex h-7 w-7 shrink-0 items-center justify-center rounded border border-edge text-muted hover:text-ink disabled:opacity-40" : "app-modal-button"}
      onClick={() => input.current?.click()}>
      <Upload size={compact ? 13 : 15} />{!compact && (busy ? "正在导入…" : "导入规范")}
    </button>
    <input ref={input} type="file" accept=".json,application/json" hidden onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (!file || pending.current) return;
      pending.current = true; setBusy(true);
      try {
        if (file.size > 256 * 1024) throw new Error("规范文件不能超过 256 KB");
        const profile = await api.visualProfileImport(await file.text());
        useStore.setState(state => ({ visualProfiles: [profile, ...state.visualProfiles] }));
        useStore.getState().openVisualProfile({ id: profile.folderId, name: profile.name, profileId: profile.id });
      } catch (error) { notifyError(error, "导入视觉规范失败"); }
      finally { pending.current = false; setBusy(false); }
    }} />
  </>;
}
