import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { canStartAnotherJob, canUseByo } from "../lib/entitlement";
import { cloudProviderLabel, isCloudProvider } from "../lib/genProviders";
import { api } from "../lib/api";
import { notifyError, notifySuccess } from "../lib/notify";
import { useCreationEditor } from "./creation/useCreationEditor";
import { RATIOS } from "./creation/ratios";
import { RatioSelect } from "./creation/RatioSelect";
import { ProviderSelect } from "./creation/ProviderSelect";
import { CreationGraph } from "./creation/CreationGraph";
import { BoardChipPreview } from "./creation/BoardChipPreview";
import { ChevronRight, Info, Sparkles } from "lucide-react";

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
  const codexHealth = useStore((s) => s.codexHealth);
  const dreaminaHealth = useStore((s) => s.dreaminaHealth);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudAvailable = cloudAuth?.cloud_available ?? false;
  const runningJobCount = useStore((s) => Object.values(s.genJobs).filter((j) => j.running).length);
  const activeGenProvider = useStore((s) => s.activeGenProvider);
  const setActiveGenProvider = useStore((s) => s.setActiveGenProvider);
  const defaultProvider = useStore((s) => s.defaultProvider);
  const setDefaultProvider = useStore((s) => s.setDefaultProvider);
  const startGeneration = useStore((s) => s.startGeneration);
  const presets = useStore((s) => s.presets);
  const activePresetId = useStore((s) => s.activePresetId);
  const setActivePreset = useStore((s) => s.setActivePreset);
  const reloadPresets = useStore((s) => s.reloadPresets);
  const tourActive = useStore((s) => s.tourActive);
  const tourStep = useStore((s) => s.tourStep);

  const {
    hostRef,
    focus,
    finalPrompt,
    rawPrompt,
    references,
    graphSources,
    agentPromptReferences,
    setChipAssetId,
    chipSections,
    showKeywordHints,
    insertKeyword,
  } = useCreationEditor();

  // tour 维度引导（step 7）：自动选中第一张有反推维度的参考图，让「可选维度」chips 面板有内容可高亮。
  useEffect(() => {
    if (tourActive && tourStep === 7 && chipSections.length === 0) {
      const withSections = references.find((r) => r.sections && r.sections.length > 0);
      if (withSections) setChipAssetId(withSections.id);
    }
  }, [tourActive, tourStep, references, chipSections.length, setChipAssetId]);

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
  const [agentMode, setAgentMode] = useState(false);
  const [agentAvailable, setAgentAvailable] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const activePreset = useMemo(
    () => presets.find((p) => p.id === activePresetId) ?? null,
    [presets, activePresetId]
  );

  useEffect(() => {
    api.localAgentHealth().then(setAgentAvailable).catch(() => setAgentAvailable(false));
  }, []);

  // 按当前选中的 provider 判健康（云端需开关+登录+余额，其余读各自 health）。
  const cloudBalance = cloudEntitlement
    ? cloudEntitlement.balances.daily + cloudEntitlement.balances.sub + cloudEntitlement.balances.topup
    : 0;
  const targetReady = isCloudProvider(activeGenProvider)
    ? cloudAvailable && !!cloudAuth?.logged_in && cloudBalance > 0
    : activeGenProvider === "jimeng"
      ? canUseByo(cloudEntitlement) && !!dreaminaHealth?.ok
      : canUseByo(cloudEntitlement) && !!codexHealth?.ok;
  const targetProviderLabel = isCloudProvider(activeGenProvider)
    ? (cloudProviderLabel(activeGenProvider, cloudEntitlement) ?? "Bowerbird Cloud")
    : activeGenProvider === "jimeng"
      ? "即梦"
      : "codex";

  // 把当前组稿发 provider 生成。生成期间编辑器仍可继续组下一轮稿（prompt 在此快照进 store）。
  // provider 由 store 内 activeGenProvider 兜底（send 不显式传）。
  async function send() {
    if (!targetReady || !finalPrompt) return;
    if (!canStartAnotherJob(cloudEntitlement, runningJobCount)) return;
    let prompt = finalPrompt;
    if (agentMode) {
      setAgentBusy(true);
      try {
        const result = await api.localAgentCompilePrompt({
          originalPrompt: rawPrompt || finalPrompt,
          references: agentPromptReferences,
          output: { kind: "图片", ...(ratio ? { ratio } : {}) },
        });
        prompt = result.prompt;
      } catch (error) {
        notifyError(error, "Agent 意图分析失败");
        return;
      } finally {
        setAgentBusy(false);
      }
    }
    await startGeneration(prompt, references, ratio, undefined, rawPrompt);
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
      notifySuccess("用途已保存");
    } catch (e) {
      console.error("createPreset failed", e);
      notifyError(e, "保存用途失败");
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
      notifySuccess("用途已更新");
    } catch (e) {
      console.error("updatePreset failed", e);
      notifyError(e, "更新用途失败");
    }
  }

  async function deletePresetById(id: string) {
    try {
      await api.deletePreset(id);
      if (activePreset?.id === id) setActivePreset(null);
      notifySuccess("用途已删除");
    } catch (e) {
      console.error("deletePreset failed", e);
      notifyError(e, "删除用途失败");
    }
  }

  return (
    <aside className="creation-board-shell flex shrink-0 flex-col border-l border-edge bg-panel">
      {/* 头部三项（创作板 / 使用说明 / 收起）沿同一水平中心线对齐：标题左对齐，图标组靠右。 */}
      <div className="creation-board-header">
        <strong className="shrink-0 text-sm font-semibold text-ink">创作板</strong>
        <div className="ml-auto flex items-center gap-1">
          <div className="group relative">
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel2 hover:text-ink"
              aria-label="使用说明"
            >
              <Info size={13} />
            </button>
            <div className="pointer-events-none absolute right-0 top-full z-10 mt-2 hidden w-60 rounded-lg bg-panel2 p-2 text-[11px] leading-4 text-muted ring-1 ring-edge group-hover:block">
              像跟 AI 输入 prompt 一样书写；<span className="text-accent">点瀑布流图片</span> 在光标处插入参考图，或输入 <span className="text-accent">@图名</span>（空格/标点后自动识别）。
            </div>
          </div>
          <button
            onClick={toggleBoard}
            className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel2 hover:text-ink"
            title="收起创作板"
            aria-label="收起创作板"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
      <div className="hatch-divider" aria-hidden="true"><span /></div>

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
        <div className="lineframe-panel border border-edge bg-canvas p-3 text-sm leading-8 text-ink">
          <div
            ref={hostRef}
            onClick={focus}
            data-tour="creation-editor"
            className="creation-editor min-h-48 cursor-text border border-edge bg-panel2/40 p-2 focus-within:border-accent"
          />
          {/* 编辑框内 image/keyword chip 的交互浮层（hover 放大图/维度正文 + 点击定位瀑布流） */}
          <BoardChipPreview hostRef={hostRef} />
          {/* 工具条：编辑框下方的快捷参数。Agent 开关与发送按钮同款线框/光晕（仅圆角不同）。 */}
          <div className="mt-2 flex items-center gap-2">
            <RatioSelect value={ratio} onChange={selectRatio} />
            <ProviderSelect
              value={activeGenProvider}
              onChange={setActiveGenProvider}
              codexHealth={codexHealth}
              dreaminaHealth={dreaminaHealth}
              cloudAvailable={cloudAvailable}
              cloudAuth={cloudAuth}
              cloudEntitlement={cloudEntitlement}
              defaultProvider={defaultProvider}
              onSetDefaultProvider={setDefaultProvider}
            />
            {agentAvailable && (
              <button
                type="button"
                role="switch"
                aria-checked={agentMode}
                disabled={agentBusy}
                onClick={() => setAgentMode((enabled) => !enabled)}
                title="开启后，Agent 会先综合原 prompt 与参考图维度，再调用当前生图引擎"
                className={`generation-glow-button flex h-7 items-center rounded-[3px] px-2.5 text-xs font-medium disabled:opacity-40 ${
                  agentMode ? "" : "is-off"
                }`}
              >
                <span className="generation-glow-button__content gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${agentMode ? "bg-lime" : "bg-muted/50"}`} />
                  Agent
                </span>
              </button>
            )}
          </div>

          {(showKeywordHints || (tourActive && tourStep === 7)) && (
            <div
              data-tour="creation-keywords"
              className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted"
            >
              {chipSections.length > 0 ? (
                <>
                  <span>可选维度（来自该图反推）：</span>
                  {chipSections.map((section) => (
                    <button
                      key={section.title}
                      data-dim={section.title}
                      onClick={() => {
                        insertKeyword(section.title, section.body);
                        // tour step 10：用户点维度 chip（如「构图」）→ 引导完成。
                        if (tourActive && tourStep === 10) {
                          useStore.getState().setTourStep(11);
                        }
                      }}
                      className="rounded-[2px] border border-accent/40 bg-accent/10 px-2 py-0.5 text-accent hover:bg-accent/20"
                    >
                      {section.title}
                    </button>
                  ))}
                </>
              ) : (
                <span>该图没有反推维度片段，可直接输入文字，或先在详情页反推生成维度。</span>
              )}
            </div>
          )}
        </div>

        <CreationGraph sources={graphSources} />
      </div>

      <div className="shrink-0 space-y-2 border-t border-edge bg-canvas/60 p-3">
        <button
          onClick={() => void send()}
          disabled={agentBusy || !finalPrompt || !targetReady || !canStartAnotherJob(cloudEntitlement, runningJobCount)}
          title={
            !targetReady
              ? `${targetProviderLabel} 不可用`
              : !canStartAnotherJob(cloudEntitlement, runningJobCount)
                ? "已达当前档位的并行生成上限"
                : agentMode
                  ? `先由 Agent 整理意图，再发 ${targetProviderLabel} 生成图像`
                  : `把当前 prompt + 参考图发 ${targetProviderLabel} 生成图像`
          }
          className="generation-glow-button flex min-h-11 w-full items-center justify-center rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          <span className="generation-glow-button__content">
            <Sparkles size={15} />
            {agentBusy ? "Agent 正在整理意图…" : `发送 ${targetProviderLabel} 生成`}
          </span>
        </button>
        <div className="text-[10px] text-muted">
          {!targetReady
            ? "请先登录 Bowerbird 账号或在「设置 · AI 出图引擎」选择可用引擎"
            : agentMode
              ? "Agent 只优化本次发送的 prompt；参考图和生成流程仍使用当前设置。"
              : "关闭 Agent 模式时，按当前编辑框 prompt 直接生成。"}
        </div>
      </div>
    </aside>
  );
}
