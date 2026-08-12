import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { api } from "../lib/api";
import { DEFAULT_AUTO_ANALYZE_PROMPT } from "../lib/constants";
import { understandProvider, understandReady } from "../lib/entitlement";
import type { MigrateProgress } from "../lib/types";

const STAGE_LABEL: Record<string, string> = {
  images: "复制原图",
  thumbnails: "复制缩略图",
  db: "整理数据库",
};

/**
 * 设置面板（约定 13 全屏 Modal 形态）：环境状态统一入口 + 入库自动反推配置 + 素材库位置迁移。
 * 重建色板 / 智能归类全部已直达到侧栏对应栏目旁；账号入口已下移到侧栏底部；即梦登录/检测
 * 收敛进「环境状态」的即梦 onboarding。由工具栏齿轮按钮唤起。点背景 / ✕ 关闭。
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const codexHealth = useStore((s) => s.codexHealth);
  const setCodexHealth = useStore((s) => s.setCodexHealth);
  const extensionConnected = useStore((s) => s.extensionConnected);
  const setOnboardingForceOpen = useStore((s) => s.setOnboardingForceOpen);
  const settings = useStore((s) => s.settings);
  const loadSettings = useStore((s) => s.loadSettings);
  const updateSettings = useStore((s) => s.updateSettings);

  // 本地编辑态：打开面板时从 store 快照初始化，失焦/按键时写回。
  const [autoAnalyzeOnIngest, setAutoAnalyzeOnIngest] = useState(false);
  const [promptText, setPromptText] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const initialized = useRef(false);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  // 理解引擎路由（入库自动反推说明文案用；free 需开启云端理解）。
  const understandRoute = understandProvider(cloudEntitlement);

  // —— 素材库位置 ——
  const [libRoot, setLibRoot] = useState<string | null>(null);
  const [migrateTarget, setMigrateTarget] = useState<string | null>(null); // 确认迁移的旧→新
  const [migrating, setMigrating] = useState(false);
  const [migrateProgress, setMigrateProgress] = useState<MigrateProgress | null>(null);
  const [migrateError, setMigrateError] = useState<string | null>(null);

  useEffect(() => {
    api.libraryRoot().then(setLibRoot).catch(() => {});
  }, []);

  // 迁移进度：后端复制大目录时逐文件推 library://migrate-progress。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen<MigrateProgress>("library://migrate-progress", (e) => {
      setMigrateProgress(e.payload);
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!initialized.current) {
      void loadSettings();
      initialized.current = true;
    }
  }, [loadSettings]);

  // 打开时刷新一次 codex 状态（看到的是当前环境，而非 App 挂载时的快照）。
  useEffect(() => {
    let alive = true;
    api
      .codexHealth()
      .then((h) => {
        if (alive) setCodexHealth(h);
      })
      .catch(() => {
        if (alive) setCodexHealth({ ok: false, reason: "codex 状态检测失败" });
      });
    return () => {
      alive = false;
    };
  }, [setCodexHealth]);

  // store.settings 加载完毕后首充本地状态（仅首次）。
  useEffect(() => {
    if (settings && !initialized.current) return; // 首次由下面这个 effect 填充
    if (settings) {
      setAutoAnalyzeOnIngest(settings.auto_analyze_on_ingest);
      setPromptText(settings.auto_analyze_prompt || DEFAULT_AUTO_ANALYZE_PROMPT);
    }
  }, [settings]);

  const allReady = understandReady({ entitlement: cloudEntitlement, codexHealth, cloudAuth }) && extensionConnected;

  const commitSettings = (onIngest: boolean, prompt: string) => {
    // 全量覆盖：只改自动反推两项，其余设置保持不变。
    void updateSettings({
      auto_analyze_on_ingest: onIngest,
      auto_analyze_prompt: prompt || DEFAULT_AUTO_ANALYZE_PROMPT,
      library_root: settings?.library_root ?? null,
      cloud_auto_understand: settings?.cloud_auto_understand ?? false,
    });
  };

  async function startMigrate() {
    if (!migrateTarget) return;
    setMigrating(true);
    setMigrateError(null);
    setMigrateProgress(null);
    try {
      await api.migrateLibraryRoot(migrateTarget);
      // 迁移成功后立即重启：lib.rs 启动时读新根并清理旧库残留。
      await api.restartApp();
    } catch (error) {
      setMigrating(false);
      setMigrateError(typeof error === "string" ? error : "迁移失败");
    }
  }

  const progress = migrateProgress
    ? STAGE_LABEL[migrateProgress.stage] ?? migrateProgress.stage
    : "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border border-edge bg-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-ink">设置</h2>

        <div className="mt-4 space-y-3 text-sm">
          {/* 环境状态：统一引导入口（codex CLI / 浏览器扩展 / 新手教程），开 Onboarding 大面板 */}
          <div className="rounded bg-panel2 px-3 py-2.5">
            <div className="flex items-center justify-between">
              <span className="text-ink">环境状态</span>
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  allReady
                    ? "bg-green-500/15 text-green-400"
                    : "bg-red-500/15 text-red-300"
                }`}
              >
                {allReady ? "全部就绪" : "有待完成项"}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              codex CLI、浏览器扩展的安装与状态，以及新手教程，集中在「环境状态」引导里。
            </p>
            <button
              onClick={() => {
                setOnboardingForceOpen(true);
                onClose();
              }}
              className="mt-2 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-black hover:opacity-90"
            >
              打开环境状态
            </button>
          </div>

          {/* 官方 Cloud 连接只读展示；URL/key 与 Mock 开关不属于用户设置。 */}
          <div className="rounded bg-panel2 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink">Bowerbird Cloud</span>
              <span className={`rounded px-2 py-0.5 text-xs ${cloudAuth?.cloud_available ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-300"}`}>
                {cloudAuth?.cloud_available ? "官方服务已配置" : "当前版本不可用"}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-muted">连接由 Bowerbird 官方构建内置，用户无需配置；算力环境由官方云端统一管理。</p>
          </div>

          {/* 入库时自动反推 */}
          <div className="rounded bg-panel2 px-3 py-2.5">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoAnalyzeOnIngest}
                onChange={(e) => {
                  const v = e.target.checked;
                  setAutoAnalyzeOnIngest(v);
                  commitSettings(v, promptText);
                }}
                className="size-4 accent-accent"
              />
              <span className="text-ink">入库时自动反推</span>
            </label>
            <p className="mt-1 ml-6 text-xs text-muted">
              开启后，新素材入库时自动调用当前账号可用的理解引擎进行反推描述与自动重命名。
              {understandRoute === "bowerbird-cloud" && " 免费版还需开启下方“允许云端理解”。"}
            </p>

            {/* 二级选项：提示词文本框 */}
            {autoAnalyzeOnIngest && (
              <div className="mt-3 ml-6">
                <label className="text-xs text-muted">自动反推提示词</label>
                <textarea
                  ref={promptRef}
                  value={promptText}
                  onChange={(e) => setPromptText(e.target.value)}
                  onBlur={() => commitSettings(autoAnalyzeOnIngest, promptText)}
                  rows={5}
                  className="mt-1 w-full rounded border border-edge bg-panel px-2.5 py-1.5 text-[12px] text-ink
                    placeholder:text-muted/50 resize-y font-mono leading-relaxed"
                  placeholder={DEFAULT_AUTO_ANALYZE_PROMPT}
                />
                <p className="mt-1 text-[11px] text-muted">
                  可用 <code className="text-[11px]">{`{vocab}`}</code>{" "}
                  表示受控类别词表，运行时会自动替换。
                </p>
              </div>
            )}
            {/* 云端理解：随账号移出设置后，勾选留在「入库时自动反推」里（本质是入库行为开关）。 */}
            <label className="mt-3 flex cursor-pointer items-start gap-2 border-t border-edge pt-2 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={settings?.cloud_auto_understand ?? false}
                onChange={(e) => settings && void updateSettings({ ...settings, cloud_auto_understand: e.target.checked })}
                disabled={!cloudAuth?.cloud_available}
                className="mt-0.5 size-3.5 accent-accent"
              />
              <span>允许入库自动分析时，把新图片临时发送到 Bowerbird Cloud 理解（默认关闭；请求结束不保存图片）</span>
            </label>
          </div>

          {/* 素材库位置 */}
          <div className="rounded bg-panel2 px-3 py-2.5">
            <div className="text-ink">素材库位置</div>
            <p className="mt-1 break-all text-[11px] text-muted" title={libRoot ?? ""}>
              {libRoot ?? "读取中…"}
            </p>

            {!migrateTarget && !migrating && (
              <button
                onClick={async () => {
                  setMigrateError(null);
                  const picked = await api.pickFolder();
                  if (picked) setMigrateTarget(picked);
                }}
                className="mt-2 rounded-md bg-panel px-3 py-1 text-[12px] text-ink hover:bg-edge"
              >
                更改位置并迁移…
              </button>
            )}

            {migrateTarget && !migrating && (
              <div className="mt-2 rounded bg-panel p-2 text-[11px]">
                <div className="text-muted">
                  将全部原图 / 缩略图 / 数据库复制到新位置，随后自动重启；旧位置文件在重启后清理，可释放系统盘空间。迁移期间请勿操作。
                </div>
                <div className="mt-1.5 break-all text-ink">
                  → <span className="text-accent">{migrateTarget}</span>
                </div>
                {migrateError && (
                  <div className="mt-1.5 text-red-300">{migrateError}</div>
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => void startMigrate()}
                    className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:opacity-90"
                  >
                    开始迁移
                  </button>
                  <button
                    onClick={() => {
                      setMigrateTarget(null);
                      setMigrateError(null);
                    }}
                    className="rounded bg-panel2 px-3 py-1 text-[12px] text-muted hover:text-ink"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {migrating && (
              <div className="mt-2 rounded bg-panel p-2 text-[11px] text-muted">
                <div>
                  正在{progress}…
                  {migrateProgress && migrateProgress.total > 0 && (
                    <span className="text-ink">
                      {" "}
                      {migrateProgress.done} / {migrateProgress.total}
                    </span>
                  )}
                </div>
                {migrateProgress && migrateProgress.total > 0 && (
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded bg-panel2">
                    <div
                      className="h-full bg-accent transition-[width]"
                      style={{
                        width: `${Math.round((migrateProgress.done / migrateProgress.total) * 100)}%`,
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 新手教程（占位，后续替换为视频/图片） */}
          <div className="rounded bg-panel2 px-3 py-2">
            <div className="text-ink">新手教程</div>
            <div className="mt-1.5 flex h-20 items-center justify-center rounded border border-dashed border-edge text-[11px] text-muted">
              📷 教程视频 / 图片（待补充）
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-black hover:opacity-90"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
