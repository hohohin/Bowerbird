import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Keyboard } from "lucide-react";
import { useStore } from "../store";
import { DEFAULT_SCREENSHOT_SHORTCUTS, displayShortcut, shortcutFromEvent } from "../lib/screenshot";
import { userErrorMessage } from "../lib/userError";
import { SettingsToggle } from "./SettingsToggle";

export function ScreenshotSettings() {
  const settings = useStore(s => s.settings);
  const shortcuts = settings?.screenshot_shortcuts ?? DEFAULT_SCREENSHOT_SHORTCUTS;
  const [recording, setRecording] = useState<"capture" | "paste" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function setAutoSave(enabled: boolean) {
    if (!settings || busy) return;
    setBusy(true); setError('');
    try {
      await useStore.getState().updateSettings({ screenshot_auto_save: enabled });
    } catch { /* The settings queue shows the error and offers retry. */ }
    finally { setBusy(false); }
  }
  useEffect(() => { void invoke<{ error: string | null }>("screenshot_shortcut_status").then(s => setError(s.error ? userErrorMessage(s.error, "暂时无法启用快捷键，请重新设置。") : "")).catch(e => setError(userErrorMessage(e, "暂时无法读取快捷键状态，请重新打开设置。"))); }, []);
  useEffect(() => {
    void invoke("screenshot_record_shortcut", { recording: recording !== null }).catch(e => setError(userErrorMessage(e, "暂时无法录入快捷键，请重试。")));
    return () => { void invoke("screenshot_record_shortcut", { recording: false }).catch(() => {}); };
  }, [recording]);
  async function save(next: typeof shortcuts) {
    setRecording(null); setBusy(true); setError("");
    try {
      await useStore.getState().updateSettings({ screenshot_shortcuts: next });
    } catch { /* The settings queue shows the error and offers retry. */ }
    finally { setBusy(false); }
  }
  return <section className="settings-card px-3 py-3" aria-label="截图设置">
    <h3 className="flex items-center gap-2 text-ink"><Keyboard size={16} aria-hidden="true" />截图设置</h3>
    <p className="mt-1 text-xs text-muted">应用运行时，全局快捷键在其他应用中也可使用。点击按键框录入，Esc 取消。</p>
    {([['capture', '区域截图'], ['paste', '剪贴板贴图']] as const).map(([key, label]) => <div key={key} className="mt-3 flex items-center justify-between gap-2">
      <span>{label}</span>
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy || !settings} aria-label={`${label}快捷键`} className={`min-w-36 rounded border px-3 py-1.5 text-xs ${recording === key ? 'border-accent text-accent' : 'border-edge bg-panel2'}`}
          onClick={() => setRecording(key)} onBlur={() => setRecording(null)}
          onKeyDown={event => {
            if (recording !== key) return;
            event.preventDefault(); event.stopPropagation();
            if (event.key === 'Escape') { setRecording(null); return; }
            const value = shortcutFromEvent(event.nativeEvent);
            if (value) void save({ ...shortcuts, [key]: value });
            else setError('请使用 F1–F24，或 Ctrl / ⌘ / Alt 加字母、数字或空格。');
          }}>{recording === key ? '请按下快捷键…' : displayShortcut(shortcuts[key])}</button>
        <button type="button" className="text-xs text-muted hover:text-ink disabled:opacity-40" disabled={busy || !settings || !shortcuts[key]} onClick={() => void save({ ...shortcuts, [key]: '' })}>停用</button>
      </div>
    </div>)}
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy || !settings} className="ml-auto text-xs text-muted hover:text-ink" onClick={() => void save(DEFAULT_SCREENSHOT_SHORTCUTS)}>恢复默认</button>
    </div>
    <div className="mt-4 flex items-center justify-between gap-3">
      <span>截图自动保存到素材库</span>
      <SettingsToggle label="截图自动保存到素材库" checked={settings?.screenshot_auto_save ?? true}
        disabled={busy || !settings} onChange={value => void setAutoSave(value)} />
    </div>
    <p className="mt-2 text-xs text-muted">Mac 首次截图需允许屏幕录制；F 键可能需配合 Fn。</p>
    {error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}
  </section>;
}
