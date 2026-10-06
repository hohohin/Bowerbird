import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Camera, Keyboard, Pin } from "lucide-react";
import { useStore } from "../store";
import { DEFAULT_SCREENSHOT_SHORTCUTS, displayShortcut, shortcutFromEvent } from "../lib/screenshot";

export function ScreenshotSettings() {
  const settings = useStore(s => s.settings);
  const shortcuts = settings?.screenshot_shortcuts ?? DEFAULT_SCREENSHOT_SHORTCUTS;
  const [recording, setRecording] = useState<"capture" | "paste" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void invoke<{ error: string | null }>("screenshot_shortcut_status").then(s => setError(s.error ?? "")).catch(e => setError(String(e))); }, []);
  useEffect(() => {
    void invoke("screenshot_record_shortcut", { recording: recording !== null }).catch(e => setError(String(e)));
    return () => { void invoke("screenshot_record_shortcut", { recording: false }).catch(() => {}); };
  }, [recording]);
  async function save(next: typeof shortcuts) {
    setRecording(null); setBusy(true); setError("");
    try {
      await invoke("screenshot_set_shortcuts", { shortcuts: next });
      await useStore.getState().loadSettings();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function run(command: string) {
    setBusy(true); setError("");
    try { await invoke(command); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <section className="settings-card px-3 py-3" aria-label="快捷键">
    <h3 className="flex items-center gap-2 text-ink"><Keyboard size={16} />快捷键</h3>
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
      <button type="button" disabled={busy} className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40" onClick={() => void run('screenshot_start')}><Camera size={14} />立即截图</button>
      <button type="button" disabled={busy} className="flex items-center gap-1.5 rounded bg-panel2 px-3 py-1.5 text-xs disabled:opacity-40" onClick={() => void run('screenshot_paste')}><Pin size={14} />贴出剪贴板图片</button>
      <button type="button" disabled={busy || !settings} className="ml-auto text-xs text-muted hover:text-ink" onClick={() => void save(DEFAULT_SCREENSHOT_SHORTCUTS)}>恢复默认</button>
    </div>
    <p className="mt-2 text-xs text-muted">拖动框选，支持标注、马赛克、复制、保存和置顶贴图。Mac 首次截图需允许屏幕录制；F 键可能需配合 Fn。</p>
    {error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}
  </section>;
}
