import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { api } from "../lib/api";
import type { CodexChunk, CreationPack } from "../lib/types";

/**
 * 选图组创作包（核心交互，开发计划 §5.4）：
 * 多选 N 张 → assemble_pack 自动组装「prompt 正文 + 参考图清单」→
 * 可编辑 → 复制外用 / 发 codex 优化（流式呈现）。
 */
export function PackPanel() {
  const selectedIds = useStore((s) => s.selectedIds);
  const ids = Array.from(selectedIds);
  const [pack, setPack] = useState<CreationPack | null>(null);
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);

  async function reload() {
    if (ids.length === 0) return;
    try {
      const p = await api.assemblePack(ids);
      setPack(p);
      setPrompt(p.prompt);
    } catch (e) {
      console.error(e);
    }
  }
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<CodexChunk>("codex://chunk", (e) => {
      const c = e.payload;
      if (c.kind === "delta") setStreaming((s) => s + c.text);
      else if (c.kind === "done")
        setStreaming((s) => s + `\n\n—— done · ${c.elapsed_ms}ms via ${c.provider}`);
      else if (c.kind === "error") setStreaming((s) => s + `\n[error: ${c.message}]`);
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  function copy() {
    const text = `# Prompt\n${prompt}\n\n# References (${
      pack?.references.length ?? 0
    })\n${pack?.references.map((r) => `- ${r}`).join("\n")}`;
    navigator.clipboard.writeText(text);
  }

  async function sendCodex() {
    setBusy(true);
    setStreaming("");
    try {
      await api.codexRunStream({
        instruction: "优化并扩写以下创作包的提示词，使其更适合 MJ/SD 使用：",
        context_prompts: [prompt],
        reference_images: pack?.references ?? [],
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">创作包（{ids.length} 张）</div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        className="h-40 w-full rounded bg-panel2 p-2 text-xs text-ink outline-none ring-1 ring-edge focus:ring-accent"
      />
      <div className="text-xs text-muted">
        参考图 {pack?.references.length ?? 0} 张（原图路径，可发外部 MJ/SD 或 codex）
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={copy}
          className="rounded bg-panel2 px-3 py-1 text-xs text-ink hover:bg-edge"
        >
          复制（prompt + 参考图清单）
        </button>
        <button
          onClick={sendCodex}
          disabled={busy}
          className="rounded bg-accent px-3 py-1 text-xs font-medium text-black disabled:opacity-50"
        >
          {busy ? "处理中…" : "发 codex 优化"}
        </button>
      </div>
      {streaming && (
        <div className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded bg-panel2 p-2 text-xs text-ink">
          {streaming}
        </div>
      )}
    </div>
  );
}
