import { useMemo, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { useCreationEditor } from "./creation/useCreationEditor";
import { RATIOS } from "./creation/ratios";
import { RatioSelect } from "./creation/RatioSelect";

// 画面比例偏好记忆（照 AssetDetail 的 localStorage 范式：bowerbird.<name> 前缀、try/catch 兜底）。
const BOARD_RATIO_KEY = "bowerbird.boardRatio";
function loadBoardRatio(): string | null {
  try {
    const v = localStorage.getItem(BOARD_RATIO_KEY);
    return v && RATIOS.some((r) => r.key === v) ? v : null;
  } catch {
    return null;
  }
}
function saveBoardRatio(v: string | null) {
  try {
    if (v) localStorage.setItem(BOARD_RATIO_KEY, v);
    else localStorage.removeItem(BOARD_RATIO_KEY);
  } catch {
    // ignore storage errors
  }
}

/**
 * 创作板 UI 外壳。编辑器内核（ProseMirror doc / 光标 / 序列化）下沉到
 * useCreationEditor + creation/* 模块，本组件只管「组稿周边」：
 * 用途（preset）CRUD / 复制 / 发送 / 维度 chips 面板 / 预览。
 *
 * 参考图入口：boardOpen 时点瀑布流任意图即在光标处插 image chip；也可手输 @图名，
 * 空格/标点后自动识别为 image chip。维度 chips 取自该图反推 sections，点击插 keyword chip。
 */
export function CreationBoard() {
  const toggleBoard = useStore((s) => s.toggleBoard);
  const generating = useStore((s) => s.generating);
  const codexHealth = useStore((s) => s.codexHealth);
  const startGeneration = useStore((s) => s.startGeneration);
  const presets = useStore((s) => s.presets);
  const activePresetId = useStore((s) => s.activePresetId);
  const setActivePreset = useStore((s) => s.setActivePreset);
  const reloadPresets = useStore((s) => s.reloadPresets);

  const {
    hostRef,
    focus,
    finalPrompt,
    references,
    chipSections,
    showKeywordHints,
    setShowKeywordHints,
    insertKeyword,
  } = useCreationEditor();

  const [copied, setCopied] = useState(false);
  // 画面比例（null=自动/不指定，发送时不注入 instruction）。记忆进 localStorage，跨会话保留。
  const [ratio, setRatio] = useState<string | null>(loadBoardRatio);
  const selectRatio = (v: string | null) => {
    setRatio(v);
    saveBoardRatio(v);
  };
  // 创作板「用途」（preset）登记：只需用途名，body 取当前编辑框内容
  const [creatingPreset, setCreatingPreset] = useState(false);
  const [newName, setNewName] = useState("");
  // 用途编辑/删除（inline）
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editBody, setEditBody] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const activePreset = useMemo(
    () => presets.find((p) => p.id === activePresetId) ?? null,
    [presets, activePresetId]
  );

  function copy() {
    const refPaths = references
      .map((r) => r.store_path)
      .filter((p): p is string => !!p);
    const text = `# Prompt\n${finalPrompt}\n\n# References (${refPaths.length})\n${refPaths
      .map((r) => `- ${r}`)
      .join("\n")}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // 把当前组稿发 codex 生成。生成期间编辑器仍可继续组下一轮稿（prompt 在此快照进 store）。
  function send() {
    if (!codexHealth?.ok || !finalPrompt || generating) return;
    void startGeneration(finalPrompt, references, ratio);
  }

  // 登记=把当前编辑框内容（finalPrompt）存为用途，只需用户给个名字。
  async function savePreset() {
    const name = newName.trim();
    const body = finalPrompt.trim();
    if (!name || !body) return;
    try {
      const id = await api.createPreset(name, body);
      await reloadPresets();
      setActivePreset(id);
      setCreatingPreset(false);
      setNewName("");
    } catch (e) {
      console.error("createPreset failed", e);
    }
  }

  function startEditPreset() {
    if (!activePreset) return;
    setEditingPresetId(activePreset.id);
    setEditName(activePreset.name);
    setEditBody(activePreset.body);
    setConfirmDeleteId(null);
  }

  async function saveEditPreset() {
    if (!editingPresetId) return;
    const name = editName.trim();
    const body = editBody.trim();
    if (!name || !body) return;
    try {
      await api.updatePreset(editingPresetId, name, body);
      setEditingPresetId(null);
    } catch (e) {
      console.error("updatePreset failed", e);
    }
  }

  async function deletePresetById(id: string) {
    try {
      await api.deletePreset(id);
      if (activePreset?.id === id) setActivePreset(null);
    } catch (e) {
      console.error("deletePreset failed", e);
    }
  }

  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l border-edge bg-panel">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">🎬 创作板</span>
          <span className="rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 text-[10px] text-accent">
            点图 / @图名 插参考图
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleBoard}
            className="rounded px-2 py-0.5 text-muted hover:bg-panel2 hover:text-ink"
            title="收起创作板"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {/* 用途（preset）：发送时作为基底注入；登记=把当前编辑框内容存为用途（只需用途名） */}
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="shrink-0 text-muted">用途</span>
          <select
            value={activePresetId ?? ""}
            onChange={(e) => setActivePreset(e.target.value || null)}
            className="min-w-0 flex-1 rounded bg-panel2 px-1.5 py-1 text-ink outline-none ring-1 ring-edge focus:ring-accent"
          >
            <option value="">默认</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {creatingPreset ? (
            <>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void savePreset();
                  if (e.key === "Escape") setCreatingPreset(false);
                }}
                placeholder="用途名"
                className="w-24 rounded bg-panel2 px-1.5 py-1 text-ink outline-none ring-1 ring-edge focus:ring-accent"
              />
              <button
                onClick={savePreset}
                disabled={!newName.trim() || !finalPrompt.trim()}
                className="shrink-0 rounded bg-accent px-2 py-1 font-semibold text-black disabled:opacity-50"
                title="把当前编辑框内容存为该用途"
              >
                ✓
              </button>
              <button
                onClick={() => {
                  setCreatingPreset(false);
                  setNewName("");
                }}
                className="shrink-0 rounded bg-panel2 px-2 py-1 text-ink hover:bg-edge"
              >
                ✕
              </button>
            </>
          ) : (
            <button
              onClick={() => setCreatingPreset(true)}
              disabled={!finalPrompt.trim()}
              className="shrink-0 rounded bg-panel2 px-2 py-1 text-ink hover:bg-edge disabled:opacity-50"
              title={finalPrompt.trim() ? "把当前编辑框内容登记为一个用途" : "编辑框为空，无内容可登记"}
            >
              登记
            </button>
          )}
        </div>
        {activePreset && editingPresetId === activePreset.id ? (
          <div className="mb-2 space-y-1.5 rounded bg-panel2 p-2">
            <input
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="用途名"
              className="w-full rounded bg-panel px-1.5 py-1 text-xs text-ink outline-none ring-1 ring-edge focus:ring-accent"
            />
            <textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              rows={4}
              placeholder="用途内容（发送时作为基底注入）"
              className="max-h-40 w-full resize-y overflow-y-auto rounded bg-panel px-1.5 py-1 text-[11px] leading-5 text-ink outline-none ring-1 ring-edge focus:ring-accent"
            />
            <div className="flex gap-1.5">
              <button
                onClick={saveEditPreset}
                disabled={!editName.trim() || !editBody.trim()}
                className="shrink-0 rounded bg-accent px-2 py-1 text-xs font-semibold text-black disabled:opacity-50"
              >
                保存
              </button>
              <button
                onClick={() => setEditingPresetId(null)}
                className="shrink-0 rounded bg-panel px-2 py-1 text-xs text-ink hover:bg-edge"
              >
                取消
              </button>
            </div>
          </div>
        ) : activePreset ? (
          <div className="mb-2 space-y-1">
            <div className="flex items-start gap-2">
              <div
                className="line-clamp-2 flex-1 text-[10px] leading-4 text-muted"
                title={activePreset.body}
              >
                基底：{activePreset.body}
              </div>
              <button
                onClick={startEditPreset}
                className="shrink-0 text-[10px] text-accent hover:underline"
                title="编辑该用途的名字与内容"
              >
                编辑
              </button>
              {confirmDeleteId === activePreset.id ? (
                <>
                  <button
                    onClick={() => {
                      void deletePresetById(activePreset.id);
                      setConfirmDeleteId(null);
                    }}
                    className="shrink-0 text-[10px] text-red-400 hover:underline"
                  >
                    确认删除
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    className="shrink-0 text-[10px] text-muted hover:underline"
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmDeleteId(activePreset.id)}
                  className="shrink-0 text-[10px] text-muted hover:text-red-400 hover:underline"
                  title="删除该用途"
                >
                  删除
                </button>
              )}
            </div>
          </div>
        ) : null}
        <div className="rounded-lg border border-edge bg-[#13171f] p-3 text-sm leading-8 text-ink">
          <div className="mb-2 text-[11px] text-muted">
            像跟 AI 输入 prompt 一样书写；<span className="rounded bg-panel2 px-1 text-accent">点瀑布流图片</span> 在光标处插入参考图，或输入 <span className="rounded bg-panel2 px-1 text-accent">@图名</span>（空格/标点后自动识别）。
          </div>
          {/* 工具条：编辑框上方的快捷参数；作 hostRef 的兄弟（不触发其 onClick={focus}）。未来可在此加更多功能。 */}
          <div className="mb-2 flex items-center gap-2">
            <RatioSelect value={ratio} onChange={selectRatio} />
          </div>
          <div
            ref={hostRef}
            onClick={focus}
            className="creation-editor min-h-36 cursor-text rounded bg-panel2/40 p-2 ring-1 ring-edge focus-within:ring-accent"
          />

          {showKeywordHints && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
              {chipSections.length > 0 ? (
                <>
                  <span>可选维度（来自该图反推）：</span>
                  {chipSections.map((section) => (
                    <button
                      key={section.title}
                      onClick={() => insertKeyword(section.title)}
                      className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-accent hover:bg-accent/20"
                    >
                      {section.title}
                    </button>
                  ))}
                </>
              ) : (
                <span>该图没有反推维度片段，可直接输入文字，或先在详情页反推生成维度。</span>
              )}
              <button
                onClick={() => setShowKeywordHints(false)}
                className="ml-auto rounded px-1 text-muted hover:bg-panel2 hover:text-ink"
                title="收起维度面板（Esc）"
              >
                ✕
              </button>
            </div>
          )}
        </div>

        <div className="mt-3">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">
            实际发送 prompt（图片 token 会按所选维度展开为片段）
          </div>
          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-panel2 p-2 text-[11px] text-ink">
            {finalPrompt || "（开始输入 prompt，或点瀑布流图片插入参考图）"}
          </pre>
        </div>
      </div>

      <div className="shrink-0 space-y-2 border-t border-edge p-3">
        <button
          onClick={send}
          disabled={!finalPrompt || !codexHealth?.ok || generating}
          title={
            !codexHealth?.ok
              ? codexHealth?.reason || "codex 不可用"
              : "把最终 prompt + 参考图发 codex CLI 生成图像（结果进「生成结果」面板）"
          }
          className="w-full rounded-md bg-accent px-3 py-2 text-sm font-semibold text-black disabled:opacity-50"
        >
          {generating ? "生成中…（见「生成结果」面板）" : "✓ 发送 codex 生成"}
        </button>
        <button
          onClick={copy}
          disabled={!finalPrompt}
          className="w-full rounded-md bg-panel2 px-3 py-1.5 text-xs text-ink hover:bg-edge disabled:opacity-50"
        >
          {copied ? "已复制 ✓" : "复制 prompt + 参考图清单"}
        </button>
        <div className="text-[10px] text-muted">
          {codexHealth && !codexHealth.ok
            ? codexHealth.reason
            : "🎨 发送后自动弹出「生成结果」面板；生成期间本板可继续组下一轮稿。"}
        </div>
      </div>
    </aside>
  );
}
