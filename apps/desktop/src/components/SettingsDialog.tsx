import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { api } from "../lib/api";
import { DEFAULT_AUTO_ANALYZE_PROMPT } from "../lib/constants";
import { understandProvider } from "../lib/entitlement";
import { ProviderSelect } from "./creation/ProviderSelect";
import { DreaminaLoginDialog } from "./DreaminaLoginDialog";
import type { MigrateProgress } from "../lib/types";

const STAGE_LABEL: Record<string, string> = {
  images: "复制原图",
  thumbnails: "复制缩略图",
  db: "整理数据库",
};

/**
 * 设置面板（约定 13 全屏 Modal 形态）：环境状态统一入口 + 入库自动反推配置 + 素材库位置迁移 +
 * AI 出图引擎（codex / 即梦 provider 切换）+ 重建色板 + 智能归类全部。
 * 由工具栏齿轮按钮唤起。点背景 / ✕ 关闭。
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const codexHealth = useStore((s) => s.codexHealth);
  const setCodexHealth = useStore((s) => s.setCodexHealth);
  const extensionConnected = useStore((s) => s.extensionConnected);
  const setOnboardingForceOpen = useStore((s) => s.setOnboardingForceOpen);
  const setDreaminaOnboardingForceOpen = useStore((s) => s.setDreaminaOnboardingForceOpen);
  const settings = useStore((s) => s.settings);
  const loadSettings = useStore((s) => s.loadSettings);
  const updateSettings = useStore((s) => s.updateSettings);
  const dreaminaHealth = useStore((s) => s.dreaminaHealth);
  const setDreaminaHealth = useStore((s) => s.setDreaminaHealth);
  const defaultProvider = useStore((s) => s.defaultProvider);
  const setDefaultProvider = useStore((s) => s.setDefaultProvider);
  const classifyProgress = useStore((s) => s.classifyProgress);
  const colorRebuild = useStore((s) => s.colorRebuild);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudBusy = useStore((s) => s.cloudBusy);
  const cloudError = useStore((s) => s.cloudError);
  const loadCloudAccount = useStore((s) => s.loadCloudAccount);
  const startCloudEmailLogin = useStore((s) => s.startCloudEmailLogin);
  const syncCloudEntitlement = useStore((s) => s.syncCloudEntitlement);
  const logoutCloud = useStore((s) => s.logoutCloud);

  // 本地编辑态：打开面板时从 store 快照初始化，失焦/按键时写回。
  const [autoAnalyzeOnIngest, setAutoAnalyzeOnIngest] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [cloudEmail, setCloudEmail] = useState("");
  const [cloudEmailSent, setCloudEmailSent] = useState(false);
  const [cloudUrl, setCloudUrl] = useState("");
  const [cloudPublishableKey, setCloudPublishableKey] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const initialized = useRef(false);
  const understandRoute = understandProvider(cloudEntitlement);
  const understandReady = understandRoute === "codex"
    ? !!codexHealth?.ok
    : understandRoute === "bowerbird-cloud"
      ? !!settings?.cloud_enabled && !!cloudAuth?.logged_in
      : false;
  const understandLabel = understandRoute === "codex" ? "codex CLI" : "Bowerbird Cloud";

  // —— 素材库位置 ——
  const [libRoot, setLibRoot] = useState<string | null>(null);
  const [migrateTarget, setMigrateTarget] = useState<string | null>(null); // 确认迁移的旧→新
  const [migrating, setMigrating] = useState(false);
  const [migrateProgress, setMigrateProgress] = useState<MigrateProgress | null>(null);
  const [migrateError, setMigrateError] = useState<string | null>(null);

  // —— 即梦 ——
  const [dreaminaChecking, setDreaminaChecking] = useState(false);
  const [dreaminaLoginOpen, setDreaminaLoginOpen] = useState(false);

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
    void loadCloudAccount();
  }, [loadCloudAccount]);

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

  // 打开时也刷一次即梦状态（独立 checking 态，不卡 codex 检测）。
  useEffect(() => {
    let alive = true;
    setDreaminaChecking(true);
    api
      .dreaminaHealth()
      .then((h) => {
        if (alive) setDreaminaHealth(h);
      })
      .catch(() => {
        if (alive) setDreaminaHealth({ ok: false, reason: "dreamina 状态检测失败" });
      })
      .finally(() => {
        if (alive) setDreaminaChecking(false);
      });
    return () => {
      alive = false;
    };
  }, [setDreaminaHealth]);

  useEffect(() => {
    if (!initialized.current) {
      void loadSettings();
      initialized.current = true;
    }
  }, [loadSettings]);

  // store.settings 加载完毕后首充本地状态（仅首次）。
  useEffect(() => {
    if (settings && !initialized.current) return; // 首次由下面这个 effect 填充
    if (settings) {
      setAutoAnalyzeOnIngest(settings.auto_analyze_on_ingest);
      setPromptText(settings.auto_analyze_prompt || DEFAULT_AUTO_ANALYZE_PROMPT);
      setCloudUrl(settings.cloud_supabase_url ?? "");
      setCloudPublishableKey(settings.cloud_supabase_publishable_key ?? "");
    }
  }, [settings]);

  const allReady = codexHealth?.ok === true && extensionConnected;

  const commitSettings = (onIngest: boolean, prompt: string) => {
    // 全量覆盖：只改自动反推两项，其余设置保持不变。
    void updateSettings({
      auto_analyze_on_ingest: onIngest,
      auto_analyze_prompt: prompt || DEFAULT_AUTO_ANALYZE_PROMPT,
      library_root: settings?.library_root ?? null,
      cloud_enabled: settings?.cloud_enabled ?? false,
      cloud_supabase_url: settings?.cloud_supabase_url ?? null,
      cloud_supabase_publishable_key: settings?.cloud_supabase_publishable_key ?? null,
      cloud_mock: settings?.cloud_mock ?? true,
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

  // 即梦状态分态：未装（reason 含「未检测到」）/ 未登录 / 就绪——决定显示安装命令还是登录按钮。
  const dreaminaReason = dreaminaHealth?.reason ?? "";
  const dreaminaNotInstalled = !dreaminaHealth?.ok && dreaminaReason.includes("未检测到");
  const dreaminaNeedsLogin = !dreaminaHealth?.ok && !dreaminaNotInstalled;

  async function recheckDreamina() {
    setDreaminaChecking(true);
    try {
      setDreaminaHealth(await api.dreaminaHealth());
    } catch {
      setDreaminaHealth({ ok: false, reason: "dreamina 状态检测失败" });
    } finally {
      setDreaminaChecking(false);
    }
  }

  async function logoutDreamina() {
    try {
      await api.dreaminaLogout();
      // logout 后刷新 health（应变「未登录」）。
      await recheckDreamina();
    } catch (e) {
      console.error("dreamina logout failed", e);
    }
  }

  async function reclassifyAll() {
    try {
      await api.reclassifyAll();
    } catch (e) {
      console.error("reclassifyAll failed", e);
    }
  }

  async function recomputeColors() {
    try {
      await api.recomputeColors();
    } catch (e) {
      console.error("recomputeColors failed", e);
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

          {/* Bowerbird Cloud 连接：公开 URL/publishable key 可存设置；secret key 永不进桌面。 */}
          <div className="rounded bg-panel2 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink">Bowerbird Cloud 连接</span>
              <span className={`rounded px-2 py-0.5 text-xs ${settings?.cloud_enabled ? "bg-green-500/15 text-green-400" : "bg-muted/15 text-muted"}`}>
                {settings?.cloud_enabled ? (settings.cloud_mock ? "Mock" : "真实服务") : "关闭"}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-muted">这里只保存公开 Project URL 与 publishable key；secret key 只放 Edge Functions。</p>
            <div className="mt-2 space-y-1.5">
              <input value={cloudUrl} onChange={(e) => setCloudUrl(e.target.value)} placeholder="https://xxxx.supabase.co" className="w-full rounded border border-edge bg-panel px-2 py-1 text-xs text-ink" />
              <input value={cloudPublishableKey} onChange={(e) => setCloudPublishableKey(e.target.value)} placeholder="sb_publishable_..." className="w-full rounded border border-edge bg-panel px-2 py-1 font-mono text-xs text-ink" />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-[11px] text-muted">
                <input type="checkbox" checked={settings?.cloud_enabled ?? false} onChange={(e) => settings && void updateSettings({ ...settings, cloud_enabled: e.target.checked })} className="accent-accent" />
                启用云端
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-muted">
                <input type="checkbox" checked={settings?.cloud_mock ?? true} onChange={(e) => settings && void updateSettings({ ...settings, cloud_mock: e.target.checked })} className="accent-accent" />
                Mock 算力
              </label>
              <button
                onClick={() => settings && void updateSettings({
                  ...settings,
                  cloud_supabase_url: cloudUrl.trim() || null,
                  cloud_supabase_publishable_key: cloudPublishableKey.trim() || null,
                })}
                className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-black"
              >保存连接配置</button>
            </div>
            <p className="mt-1 text-[10px] text-amber-300">连接配置在 app 启动时载入；保存或切换真实/Mock 后请重启 Bowerbird。</p>
          </div>

          {/* Bowerbird 账号：token 只存在 Rust/keychain，前端仅展示脱敏状态。 */}
          <div className="rounded bg-panel2 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink">Bowerbird 账号</span>
              <span className={`rounded px-2 py-0.5 text-xs ${cloudAuth?.logged_in ? "bg-green-500/15 text-green-400" : "bg-amber-500/15 text-amber-300"}`}>
                {cloudAuth?.logged_in ? cloudEntitlement?.tier?.toUpperCase() || "已登录" : cloudAuth?.reason || "未登录"}
              </span>
            </div>
            {cloudAuth?.logged_in ? (
              <>
                <p className="mt-1 text-xs text-muted">{cloudAuth.email || cloudAuth.user_id}</p>
                <div className="mt-2 grid grid-cols-3 gap-1 text-center text-[11px]">
                  <div className="rounded bg-panel p-1.5"><div className="text-muted">每日</div><div className="text-ink">{cloudEntitlement?.balances.daily ?? 0}</div></div>
                  <div className="rounded bg-panel p-1.5"><div className="text-muted">订阅</div><div className="text-ink">{cloudEntitlement?.balances.sub ?? 0}</div></div>
                  <div className="rounded bg-panel p-1.5"><div className="text-muted">充值</div><div className="text-ink">{cloudEntitlement?.balances.topup ?? 0}</div></div>
                </div>
                <div className="mt-2 flex gap-2">
                  <button onClick={() => void syncCloudEntitlement()} disabled={cloudBusy} className="rounded-md bg-panel px-3 py-1 text-xs text-ink hover:bg-edge disabled:opacity-50">刷新权益</button>
                  <button onClick={() => void logoutCloud()} disabled={cloudBusy} className="rounded-md bg-panel px-3 py-1 text-xs text-ink hover:bg-red-500/20 hover:text-red-300 disabled:opacity-50">登出</button>
                </div>
                {(cloudEntitlement?.recent_transactions?.length ?? 0) > 0 && (
                  <div className="mt-3 border-t border-edge pt-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted">最近积分流水</div>
                    <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto text-[11px]">
                      {cloudEntitlement!.recent_transactions.slice(0, 50).map((tx, index) => (
                        <li key={`${tx.created_at}-${index}`} className="flex items-center justify-between gap-2 text-muted">
                          <span className="truncate">{tx.kind}{tx.service ? ` · ${tx.service}` : ""}</span>
                          <span className={tx.amount >= 0 ? "text-green-400" : "text-red-300"}>{tx.amount >= 0 ? `+${tx.amount}` : tx.amount}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="mt-1 text-xs text-muted">邮箱魔法链接登录。素材库仍完全本地；只有明确选择云能力时才临时发送所选内容。</p>
                <div className="mt-2 flex gap-2">
                  <input type="email" value={cloudEmail} onChange={(e) => setCloudEmail(e.target.value)} placeholder="you@example.com" className="min-w-0 flex-1 rounded border border-edge bg-panel px-2 py-1 text-xs text-ink" />
                  <button
                    onClick={async () => {
                      try {
                        await startCloudEmailLogin(cloudEmail);
                        setCloudEmailSent(true);
                      } catch { /* store 已展示错误 */ }
                    }}
                    disabled={cloudBusy || !settings?.cloud_enabled || !cloudEmail}
                    className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-black disabled:opacity-40"
                    title={!settings?.cloud_enabled ? "先在配置中启用 Bowerbird Cloud" : "发送登录邮件"}
                  >发送链接</button>
                </div>
                {cloudEmailSent && <p className="mt-1 text-[11px] text-green-400">登录邮件已发送，请在本机浏览器完成验证。</p>}
              </>
            )}
            {cloudError && <p className="mt-1 text-[11px] text-red-300">{cloudError}</p>}
            <label className="mt-3 flex cursor-pointer items-start gap-2 border-t border-edge pt-2 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={settings?.cloud_auto_understand ?? false}
                onChange={(e) => settings && void updateSettings({ ...settings, cloud_auto_understand: e.target.checked })}
                disabled={!settings?.cloud_enabled}
                className="mt-0.5 size-3.5 accent-accent"
              />
              <span>允许入库自动分析时，把新图片临时发送到 Bowerbird Cloud 理解（默认关闭；请求结束不保存图片）</span>
            </label>
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
              {understandRoute === "bowerbird-cloud" && " 免费版还需开启上方“允许云端理解”。"}
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
          </div>

          {/* AI 出图引擎（Phase 3：codex / 即梦 多 provider 切换） */}
          <div className="rounded bg-panel2 px-3 py-2.5">
            <div className="text-ink">AI 出图引擎</div>
            <p className="mt-1 text-[11px] text-muted">
              默认用哪个 provider 出图（创作板发送时使用，可在创作板临时切换）。
            </p>
            <div className="mt-2 flex items-center gap-2">
              <ProviderSelect
                value={defaultProvider}
                onChange={setDefaultProvider}
                codexHealth={codexHealth}
                dreaminaHealth={dreaminaHealth}
                cloudEnabled={settings?.cloud_enabled ?? false}
                cloudAuth={cloudAuth}
                cloudEntitlement={cloudEntitlement}
              />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <div
                className={`rounded px-2 py-1 text-xs ${
                  dreaminaHealth?.ok
                    ? "bg-accent/15 text-accent"
                    : "bg-amber-500/15 text-amber-300"
                }`}
              >
                {dreaminaChecking
                  ? "检测中…"
                  : dreaminaHealth?.ok
                    ? "即梦已就绪"
                    : dreaminaNotInstalled
                      ? "dreamina CLI 未安装"
                      : dreaminaHealth?.reason || "即梦未就绪"}
              </div>
              <button
                onClick={() => void recheckDreamina()}
                disabled={dreaminaChecking}
                className="rounded-md bg-panel2 px-3 py-1 text-xs text-ink hover:bg-edge disabled:opacity-50"
              >
                重新检测
              </button>
              <button
                onClick={() => setDreaminaLoginOpen(true)}
                disabled={!dreaminaNeedsLogin || dreaminaChecking}
                className="rounded-md bg-panel2 px-3 py-1 text-xs text-ink hover:bg-edge disabled:opacity-50"
                title={
                  dreaminaHealth?.ok
                    ? "已登录"
                    : dreaminaNotInstalled
                      ? "先安装 dreamina CLI"
                      : "dreamina login（OAuth Device Flow）"
                }
              >
                登录即梦账号
              </button>
              <button
                onClick={() => void logoutDreamina()}
                disabled={dreaminaHealth?.ok !== true || dreaminaChecking}
                className="rounded-md bg-panel2 px-3 py-1 text-xs text-ink hover:bg-red-500/20 hover:text-red-300 disabled:opacity-50"
                title="登出即梦账号（dreamina logout）"
              >
                登出即梦账号
              </button>
            </div>
            {dreaminaNotInstalled && (
              <div className="mt-2 rounded bg-panel p-2">
                <div className="text-[10px] uppercase tracking-wide text-muted">
                  安装 dreamina CLI
                </div>
                <button
                  onClick={() => {
                    setDreaminaOnboardingForceOpen(true);
                    onClose();
                  }}
                  className="mt-1 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:opacity-90"
                >
                  一键安装 dreamina CLI
                </button>
                <div className="mt-1 text-[10px] text-muted">
                  app 自动下载官方二进制，无需打开终端；装完点「登录即梦账号」。
                </div>
              </div>
            )}
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

          {/* 重建色板 */}
          <div className="rounded bg-panel2 px-3 py-2.5">
            <div className="text-ink">重建色板</div>
            <p className="mt-1 text-[11px] text-muted">
              重新量化全库主色到颜色桶（存量图补上色板）。后台跑，完成后侧栏色板自动刷新。
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => void recomputeColors()}
                disabled={!!colorRebuild}
                className="rounded-md bg-panel px-3 py-1 text-[12px] text-ink hover:bg-edge disabled:opacity-50"
              >
                重建色板
              </button>
              {colorRebuild && (
                <span className="text-xs tabular-nums text-muted">
                  重建中 {colorRebuild.done}/{colorRebuild.total}
                </span>
              )}
            </div>
          </div>

          {/* 智能归类全部 */}
          <div className="rounded bg-panel2 px-3 py-2.5">
            <div className="text-ink">智能归类全部</div>
            <p className="mt-1 text-[11px] text-muted">
              对所有「无类别且已反推」的图，按描述重新自动归类（后台跑，仅归类不改名/描述）。
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => void reclassifyAll()}
                disabled={!!classifyProgress || !understandReady}
                title={understandReady
                  ? `使用 ${understandLabel} 重新归类`
                  : "免费版需要先登录并启用 Bowerbird Cloud；Pro 可使用本机 CLI"}
                className="rounded-md bg-panel px-3 py-1 text-[12px] text-ink hover:bg-edge disabled:opacity-50"
              >
                智能归类全部
              </button>
              {classifyProgress && (
                <span className="text-xs tabular-nums text-muted">
                  归类中 {classifyProgress.done}/{classifyProgress.total}
                </span>
              )}
            </div>
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
        {dreaminaLoginOpen && (
          <DreaminaLoginDialog open onClose={() => setDreaminaLoginOpen(false)} />
        )}
      </div>
    </div>
  );
}
