import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-shell";
import { ChevronDown, Moon, RefreshCw, Sun } from "lucide-react";
import { useStore } from "../store";
import type { SettingsRequest, SettingsSection, UnderstandProviderPref } from "../lib/types";
import { api } from "../lib/api";
import { ONBOARDING_FEATURE_ENABLED, LEGACY_SETTINGS_ENABLED } from "../lib/featureFlags";
import { DEFAULT_AUTO_ANALYZE_PROMPT, WEBSITE_URL } from "../lib/constants";
import { useOnboarding } from "../lib/onboardingStore";
import { ModalShell } from "./ModalShell";
import { RedeemCodeCard } from "./RedeemCodeCard";
import { ScreenshotSettings } from "./ScreenshotSettings";
import { AppUpdateCard } from "./AppUpdateCard";
import { useAppUpdater } from "../lib/appUpdater";
import { fileWorkspace } from "../lib/fileWorkspace";
import { FileWorkspaceMoveDialog } from "./FileWorkspaceMoveDialog";
import { CreditDetails } from "./CreditDetails";
import { AccountBilling } from "./AccountBilling";
import { accountEntitlement, canUseByo, understandEngineUsable } from "../lib/entitlement";
import { displayCreditBalances } from "../lib/creditHistory";
import { DshSubscriptionCard } from "./DshSubscriptionCard";
import { userErrorMessage } from "../lib/userError";

import { AccountLogoutConfirmation } from "./AccountLogoutConfirmation";
import { SettingsToggle as Toggle } from "./SettingsToggle";
import { LocalSubscriptionCards, useLocalSubscriptions } from "./LocalSubscriptionCards";
import { accountErrorMessage } from "../lib/accountError";

/** 开发者选项里的单个 Agent 模式开关卡片（与个性化分区卡片同款形态）。 */
function AgentModeCard({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="settings-card px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-ink">{label}</span>
        <Toggle label={label} checked={checked} disabled={disabled} onChange={onChange} />
      </div>
      <p className="mt-1 text-xs text-muted">{description}</p>
    </div>
  );
}

const SECTIONS: { key: SettingsSection; label: string }[] = [
  { key: "system", label: "系统设置" },
  { key: "account", label: "账号管理" },
  { key: "credits", label: "积分明细" },
  { key: "models", label: "模型设置" },
  { key: "personalization", label: "个性化" },
  { key: "about", label: "关于我们" },
];

/** 开发者选项分区：仅测试账号（entitlement.is_test_account）追加在导航末尾。 */
const DEVELOPER_SECTION = { key: "developer", label: "开发者选项" } as const;

function ProTrial({ userId, available }: { userId: string; available: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function start() {
    setBusy(true);
    setMessage("");
    try {
      const next = await api.cloudStartProTrial(userId);
      const auth = useStore.getState().cloudAuth;
      if (!auth?.logged_in || auth.user_id !== userId || next.user_id !== userId) return;
      useStore.setState({ cloudEntitlement: next });
      setMessage(next.tier === "pro"
        ? "7 天 Pro 功能体验已领取；Cloud 仍按用量计费，到期不会自动扣款。"
        : "当前没有生效的 Pro 体验，可刷新权益查看。");
    } catch (error) {
      setMessage(userErrorMessage(error, "暂时无法领取体验，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  }
  if (!available && !message) return null;
  return <div className="settings-card space-y-2 p-3">
    {available && <>
      <button type="button" className="app-modal-button is-primary" disabled={busy} onClick={() => void start()}>
        {busy ? "领取中…" : "领取一次 7 天 Pro 功能体验"}
      </button>
      <p className="account-billing-note">每个账号可体验一次。Cloud 按用量计费，体验到期不会自动扣款。</p>
    </>}
    {message && <p role="status" className="text-xs text-muted">{message}</p>}
  </div>;
}

export function SettingsDialog({ onClose, initialSection = "system", initialSubscription, navigationRequest }: {
  onClose: () => void;
  initialSection?: SettingsSection;
  initialSubscription?: SettingsRequest["subscription"];
  navigationRequest?: SettingsRequest;
}) {
  const subscriptions = useLocalSubscriptions();
  const { codexHealth, codex, dreamina } = subscriptions;
  const extensionConnected = useStore((s) => s.extensionConnected);
  const setExtensionOnboardingForceOpen = useStore((s) => s.setExtensionOnboardingForceOpen);
  const setCodexOnboardingForceOpen = useStore((s) => s.setCodexOnboardingForceOpen);
  const setDreaminaOnboardingForceOpen = useStore((s) => s.setDreaminaOnboardingForceOpen);
  const setAccountOnboardingForceOpen = useStore((s) => s.setAccountOnboardingForceOpen);
  const startTour = useOnboarding((s) => s.open);
  const settings = useStore((s) => s.settings);
  const loadSettings = useStore((s) => s.loadSettings);
  const saveSettings = useStore(s => s.updateSettings);
  const settingsSaveError = useStore(s => s.settingsSaveError);
  const retrySettings = useStore(s => s.retrySettings);
  const updateSettings = (patch: Parameters<typeof saveSettings>[0]) => saveSettings(patch).catch(() => {});
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudBusy = useStore((s) => s.cloudBusy);
  const syncCloudEntitlement = useStore((s) => s.syncCloudEntitlement);
  const cloudError = useStore(s => s.cloudError);
  const defaultUnderstandProvider = useStore((s) => s.defaultUnderstandProvider);

  const [selectedSection, setSection] = useState<SettingsSection>(initialSection);
  const subscriptionCard = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    setSection(initialSection);
    if (!initialSubscription) return;
    const frame = requestAnimationFrame(() => {
      subscriptionCard.current?.scrollIntoView({ block: "nearest" });
      subscriptionCard.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialSection, initialSubscription, navigationRequest]);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [logoutUserId, setLogoutUserId] = useState<string | null>(null);
  const [dshBusy, setDshBusy] = useState(false);

  const autoAnalyzeOnIngest = settings?.auto_analyze_on_ingest ?? false;
  const promptId = useId();
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const pendingPrompt = useRef<string | null>(null);
  const savedPrompt = settings?.auto_analyze_prompt || DEFAULT_AUTO_ANALYZE_PROMPT;

  function savePrompt() {
    if (pendingPrompt.current === null) return;
    const prompt = pendingPrompt.current || DEFAULT_AUTO_ANALYZE_PROMPT;
    pendingPrompt.current = null;
    setPromptDraft(null);
    if (prompt !== savedPrompt) void updateSettings({ auto_analyze_prompt: prompt });
  }

  // —— 素材库位置 ——
  const [libRoot, setLibRoot] = useState<string | null>(null);
  const [migrateTarget, setMigrateTarget] = useState<string | null>(null); // 确认迁移的旧→新
  const [fileMoveOpen, setFileMoveOpen] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState("读取中…");
  useEffect(() => {
    if (fileMoveOpen) return;
    let active = true;
    void fileWorkspace.status().then(status => {
      if (active) setWorkspaceRoot(status.proposed_root);
    }).catch(() => { if (active) setWorkspaceRoot("无法读取当前位置"); });
    return () => { active = false; };
  }, [fileMoveOpen]);

  const [migrating, setMigrating] = useState(false);
  const [migrateError, setMigrateError] = useState<string | null>(null);

  useEffect(() => {
    api.libraryRoot().then(setLibRoot).catch(() => {});
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  useEffect(() => { void loadSettings(); }, [loadSettings]);

  const migration = useRef<"picking" | "library" | "workspace" | null>(null);
  const [picking, setPicking] = useState(false);
  async function chooseMigrationTarget() {
    if (migration.current) return;
    migration.current = "picking";
    setPicking(true);
    setMigrateError(null);
    try {
      const picked = await api.pickFolder();
      if (picked) setMigrateTarget(picked);
    } catch (error) {
      setMigrateError(userErrorMessage(error, "无法打开文件夹选择，请重试。"));
    } finally {
      migration.current = null;
      setPicking(false);
    }
  }

  function openFileMove() {
    if (migration.current) return;
    migration.current = "workspace";
    setFileMoveOpen(true);
  }

  async function startMigrate() {
    if (!migrateTarget || migration.current) return;
    migration.current = "library";
    setMigrating(true);
    setMigrateError(null);
    try {
      await useStore.getState().projectCanvasFlush?.();
      await api.migrateLibraryRoot(migrateTarget);
      await api.restartApp();
    } catch (error) {
      migration.current = null;
      setMigrating(false);
      setMigrateError(userErrorMessage(error, "迁移未完成，请检查保存位置后重试。"));
    }
  }

  // 默认反推模型：非 auto 选项仅在对应引擎当下可用时可选（门控与选择浮层一致）。
  const cloudUsable = understandEngineUsable({ cloudAuth, cloudEntitlement, codexHealth }, "bowerbird-cloud");
  const codexUsable = understandEngineUsable({ cloudAuth, cloudEntitlement, codexHealth }, "codex");
  const understandOptions: { key: UnderstandProviderPref; label: string; ok: boolean; reason?: string }[] = [
    { key: "auto", label: "自动（按账号档位）", ok: true },
    {
      key: "bowerbird-cloud",
      label: "Bowerbird Cloud",
      ok: cloudUsable,
      reason: cloudUsable ? undefined : "需已登录且有积分",
    },
    {
      key: "codex",
      label: "本机 codex",
      ok: codexUsable,
      reason: codexUsable ? undefined : "需 Pro+ 且本机 CLI 就绪",
    },
  ];

  const loggedIn = cloudAuth?.logged_in === true;
  const accountName = cloudAuth?.display_name || cloudAuth?.email || cloudAuth?.user_id || "";
  // 测试账号（bowerbird_test 标记，云端随权益快照下发）才追加「开发者选项」分区。
  const current = accountEntitlement(cloudEntitlement, loggedIn ? cloudAuth?.user_id : null);
  const isTestAccount = current?.is_test_account === true;
  const sections = (isTestAccount ? [...SECTIONS, DEVELOPER_SECTION] : SECTIONS).filter(item => loggedIn || item.key !== "credits");
  const section = sections.some(item => item.key === selectedSection) ? selectedSection : "account";
  const modelIssue = !!current && !cloudUsable && !codexUsable && codex.busy !== "check";
  const cliBusy = [codex.busy, dreamina.busy].some(operation => operation === "auth" || operation === "logout") || dshBusy;
  const installingUpdate = useAppUpdater(s => s.phase === "installing");
  const preventClose = migrating || fileMoveOpen || picking || cliBusy || installingUpdate;
  useLayoutEffect(() => { if (content.current) content.current.scrollTop = 0; }, [section]);
  useLayoutEffect(() => {
    if (section !== "models") savePrompt();
  }, [section]);

  function selectSection(next: SettingsSection) {
    savePrompt();
    setSection(next);
  }

  function requestClose() {
    if (preventClose || migration.current ||
        [codex.active.current, dreamina.active.current].some(operation => operation === "auth" || operation === "logout")) return false;
    savePrompt();
    onClose();
    return true;
  }

  return (
    <ModalShell
      title="设置"
      eyebrow="Preferences"
      width="lg"
      className="settings-dialog"
      preventClose={preventClose}
      onClose={requestClose}
    >
      {/* 固定高度：不随分区内容多少变化；右列内部滚动 */}
      <div className="flex h-[480px] min-h-0 gap-4 text-sm">
        {/* 左列：分区导航 */}
        <nav className="settings-nav flex w-36 shrink-0 flex-col gap-0.5 overflow-y-auto" aria-label="设置分区">
          {sections.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => selectSection(s.key)}
              disabled={preventClose && section !== s.key}
              aria-current={section === s.key ? "true" : undefined}
              className={`settings-nav-item ${section === s.key ? "is-active" : ""}`}
            >
              {s.label}
              {s.key === "models" && modelIssue && <span className="ml-2 text-red-500" role="img" aria-label="反推模型未就绪">!</span>}
            </button>
          ))}
        </nav>

        {/* 右列：具体内容（内容超出时列内滚动） */}
        <div ref={content} className="min-w-0 flex-1 space-y-3 overflow-y-auto overscroll-contain">
          {settingsSaveError != null && <p role="alert" className="settings-card px-3 py-2 text-sm">
            {userErrorMessage(settingsSaveError, "设置未保存，请重试。")} <button type="button" onClick={() => void retrySettings().catch(() => {})}>重试保存</button>
          </p>}
          {section === "system" && (
            <>
              <AppUpdateCard version={appVersion} migrating={preventClose} />
              {/* 外观：后端 settings.json 持久化；夜间模式沿用原有黑色 UI。 */}
              <div className="settings-card px-3 py-2.5">
                <div className="text-ink">外观</div>
                <div className="mt-2 grid grid-cols-2 gap-2" role="radiogroup" aria-label="应用外观">
                  {([
                    { value: "light" as const, label: "日间模式", icon: Sun },
                    { value: "dark" as const, label: "夜间模式", icon: Moon },
                  ]).map(({ value, label, icon: Icon }) => {
                    const selected = (settings?.theme ?? "light") === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={!settings}
                        onClick={() => settings && void updateSettings({ theme: value })}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                          selected
                            ? "border-accent bg-accent/10 text-accent"
                            : "border-edge bg-canvas/60 text-muted hover:border-muted hover:text-ink"
                        }`}
                      >
                        <Icon size={15} aria-hidden="true" />
                        <span className="font-medium">{label}</span>
                        {selected && <span className="ml-auto text-[10px]">当前</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 素材库位置 */}
              <div className="settings-card px-3 py-2.5">
                <div className="text-ink">资料文件夹</div>
                <p className="mt-1 break-all text-xs text-muted">{workspaceRoot}</p>
                <p className="mt-1 text-xs text-muted">保存项目文件和随图资料。也可把历史素材按项目整理到这里。</p>
                <button type="button" className="app-button-secondary mt-2" disabled={preventClose} onClick={openFileMove}>管理资料文件夹…</button>
              </div>
              <div className="settings-card px-3 py-2.5">
                <div className="text-ink">历史素材索引与缓存位置</div>
                <p className="mt-1 break-all text-[11px] text-muted" title={libRoot ?? ""}>
                  {libRoot ?? "读取中…"}
                </p>

                <p className="mt-1 text-xs text-muted">存放素材库数据库、旧库原件和预览缓存。需要为它们腾出磁盘空间时再移动，可与资料文件夹分别设置。</p>
                {!migrateTarget && !migrating && (
                  <button
                    type="button"
                    onClick={() => void chooseMigrationTarget()}
                    disabled={preventClose}
                    className="mt-2 rounded-md bg-panel px-3 py-1 text-[12px] text-ink hover:bg-edge"
                  >
                    更改索引库位置…
                  </button>
                )}

                {migrateError && <p role="alert" className="mt-1.5 text-xs text-red-300">{migrateError}</p>}
                {migrateTarget && !migrating && (
                  <div className="mt-2 rounded bg-panel p-2 text-[11px]">
                    <div className="text-muted">
                      应用将重启，把索引库、原图、图层和缩略图复制到新位置。校验成功后切换，旧位置保留完整副本。
                    </div>
                    <div className="mt-1.5 break-all text-ink">
                      → <span className="text-accent">{migrateTarget}</span>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button
                        disabled={preventClose}
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
                    正在保存迁移计划并重启…
                  </div>
                )}
              </div>

              {/* 旧版本功能：浏览器扩展检测与未就绪提醒已隐藏。 */}
              {LEGACY_SETTINGS_ENABLED && <div className="settings-card px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-ink">浏览器扩展</span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      extensionConnected
                        ? "bg-green-500/15 text-green-400"
                        : "bg-red-500/15 text-red-300"
                    }`}
                  >
                    {extensionConnected ? "✓ 已连接" : "✗ 未连接"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  安装扩展后在网页拖图 / Alt + 点击即可采集素材到 Bowerbird。
                </p>
                <button
                  onClick={() => {
                    if (requestClose()) setExtensionOnboardingForceOpen(true);
                  }}
                  className="mt-2 rounded-md bg-panel px-3 py-1 text-[12px] text-ink hover:bg-edge"
                >
                  {extensionConnected ? "查看引导" : "前往配置"}
                </button>
              </div>}

              {/* 入门引导：主线续学与按需教程 */}
              {ONBOARDING_FEATURE_ENABLED && <div className="settings-card px-3 py-2">
                <div className="text-ink">入门引导</div>
                <p className="mt-1 text-xs text-muted">
                    在项目画板上学习拖图、参考、图片特征与生成；可续学或查看按需教程。
                </p>
                <button
                  onClick={() => {
                    if (requestClose()) startTour();
                  }}
                  className="mt-2 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-white hover:opacity-90"
                >
                  打开入门引导
                </button>
              </div>}
            </>
          )}

          {section === "account" && (
            <>
              {/* 账号名 */}
              <div className="settings-card px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-ink">
                    {loggedIn ? accountName : "未登录"}
                  </span>
                  {loggedIn ? (
                    <button
                      onClick={() => void syncCloudEntitlement()}
                      disabled={cloudBusy}
                      className="shrink-0 text-xs text-muted hover:text-accent disabled:opacity-50"
                    >
                      <RefreshCw size={13} aria-hidden="true" className="mr-1 inline-block align-middle" />{cloudBusy ? "同步中…" : "刷新权益"}
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        if (requestClose()) setAccountOnboardingForceOpen(true);
                      }}
                      className="shrink-0 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:opacity-90"
                    >
                      登录 Bowerbird 账号
                    </button>
                  )}
                </div>
              </div>

              {loggedIn && <section aria-label="账号概览" className="settings-card account-overview">
                <div>
                  <h3>当前方案</h3>
                  <strong>{current ? { free: "免费版", pro: "Pro", studio: "Studio" }[current.tier] : "权益待同步"}</strong>
                  {current?.tier !== "free" && current?.membership_ends_at && <p className="account-billing-note">
                    有效期至 <time dateTime={current.membership_ends_at}>{new Date(current.membership_ends_at).toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
                  </p>}
                  {current?.policy.can_use_byo && <button type="button" className="app-modal-button" onClick={() => selectSection("models")}>
                    管理自有订阅
                  </button>}
                </div>
                <div>
                  <h3>可用余额</h3>
                  <strong>{displayCreditBalances(current)?.total.toLocaleString("zh-CN") ?? "—"} <small>Bcoin</small></strong>
                  <button type="button" className="app-modal-button" onClick={() => selectSection("credits")}>查看积分明细</button>
                </div>
              </section>}
              {loggedIn && cloudAuth?.user_id && <ProTrial key={`trial-${cloudAuth.user_id}`} userId={cloudAuth.user_id} available={current?.tier === "free" && current.trial_available !== false} />}
              {loggedIn && <RedeemCodeCard key={cloudAuth?.user_id} />}
              <details className="settings-card account-plan-disclosure p-3">
                <summary className="cursor-pointer text-ink">查看会员方案与充值<ChevronDown size={16} aria-hidden="true" /></summary>
                <AccountBilling key={cloudAuth?.user_id ?? "guest"} loggedIn={loggedIn} entitlement={current} />
              </details>
              {cloudError && <p className="text-xs text-red-300" role="alert">{accountErrorMessage(cloudError)}</p>}
              {loggedIn && <button type="button" onClick={() => setLogoutUserId(cloudAuth?.user_id ?? null)} disabled={cloudBusy || !cloudAuth?.user_id} className="app-modal-button is-danger">登出账号</button>}
            </>
          )}
          {section === "credits" && loggedIn && <div className="settings-card p-3">
            <CreditDetails entitlement={current} />
            {!current && <button type="button" className="app-modal-button mt-2" disabled={cloudBusy} onClick={() => void syncCloudEntitlement()}>
              <RefreshCw size={13} aria-hidden="true" className="mr-1 inline-block align-middle" />{cloudBusy ? "同步中…" : "刷新权益"}
            </button>}
          </div>}
          <div hidden={section !== "models"} className="space-y-3">
              <section aria-labelledby="byo-heading" className="space-y-3">
                <h3 id="byo-heading" className="font-medium text-ink">自有订阅</h3>
                <LocalSubscriptionCards subscriptions={subscriptions} target={initialSubscription} cardRef={subscriptionCard}
                  onOpenGuide={target => {
                    if (!requestClose()) return;
                    if (target === "codex") setCodexOnboardingForceOpen(true);
                    else setDreaminaOnboardingForceOpen(true);
                  }} />
                <DshSubscriptionCard allowed={canUseByo(current)} cardRef={initialSubscription === "dsh" ? subscriptionCard : undefined}
                  onOperationChange={setDshBusy} />
              </section>

              {/* 默认反推模型：非 auto 时跳过每次的引擎选择浮层直接执行 */}
              <div className="settings-card px-3 py-2.5">
                <div className="text-ink">默认反推模型</div>
                <p className="mt-1 text-xs text-muted">
                  选定后直接使用该引擎反推。引擎不可用时会弹出选择菜单。
                </p>
                {modelIssue && <p className="mt-1 text-xs text-muted" role="status">
                  {canUseByo(current) ? "请连接上方的 ChatGPT 订阅，或检查 Cloud 的可用余额。" : "请检查 Cloud 是否可用，以及账号是否有 Bcoin 余额。"}
                </p>}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {understandOptions.map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => void updateSettings({ default_understand_provider: opt.key })}
                      disabled={!settings || !opt.ok}
                      aria-pressed={defaultUnderstandProvider === opt.key}
                      title={opt.ok ? opt.label : opt.reason}
                      className={`rounded px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${
                        defaultUnderstandProvider === opt.key
                          ? "bg-accent font-medium text-black"
                          : "bg-panel text-ink hover:bg-edge"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 入库时自动反推 */}
              <div className="settings-card px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-ink">入库时自动反推</span>
                  <Toggle
                    label="入库时自动反推"
                    checked={autoAnalyzeOnIngest}
                    disabled={!settings}
                    onChange={value => {
                      savePrompt();
                      void updateSettings({ auto_analyze_on_ingest: value });
                    }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted">
                  开启后，新素材入库时自动调用当前账号可用的理解引擎进行反推描述与自动重命名。
                </p>

                {/* 二级选项：提示词文本框 */}
                {autoAnalyzeOnIngest && (
                  <div className="mt-3 ml-6">
                    <label htmlFor={promptId} className="text-xs text-muted">自动反推提示词</label>
                    <textarea
                      id={promptId}
                      value={promptDraft ?? savedPrompt}
                      onChange={event => {
                        pendingPrompt.current = event.target.value;
                        setPromptDraft(event.target.value);
                      }}
                      onBlur={savePrompt}
                      rows={5}
                      className="mt-1 w-full rounded border border-edge bg-panel px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-ink
                        placeholder:text-muted/50 resize-y"
                      placeholder={DEFAULT_AUTO_ANALYZE_PROMPT}
                    />
                    <p className="mt-1 text-[11px] text-muted">
                        此提示词用于命名和描述。分类标签请在侧栏「分类标签 → 管理」中使用本地模型处理。
                    </p>
                  </div>
                )}
              </div>
          </div>

          {section === "personalization" && (
            <>
              <ScreenshotSettings />
              <div className="settings-card px-3 py-2.5">
                <label className="flex items-center justify-between gap-3">
                  <span className="text-ink">显示画板素材名称</span>
                  <Toggle label="显示画板素材名称" checked={settings?.canvas_show_asset_names ?? false} disabled={!settings}
                    onChange={value => settings && void updateSettings({ canvas_show_asset_names: value })} />
                </label>
                <p className="mt-1 text-xs text-muted">在画板图片和视频下方显示素材名称，默认关闭。</p>
              </div>
              <div className="settings-card px-3 py-2.5">
                <div className="text-ink">生成完成提醒</div>
                <p className="mt-1 text-xs text-muted">图片、视频或 Agent 产物生成成功后提醒，切换项目后仍然有效。</p>
                <label className="mt-3 flex items-center justify-between">
                  <span>弹窗提示</span>
                  <Toggle
                    label="弹窗提示"
                    checked={settings?.generation_completion_popup ?? true}
                    disabled={!settings}
                    onChange={(v) => settings && void updateSettings({ generation_completion_popup: v })}
                  />
                </label>
                <label className="mt-3 flex items-center justify-between">
                  <span>提示音</span>
                  <Toggle
                    label="提示音"
                    checked={settings?.generation_completion_sound ?? true}
                    disabled={!settings}
                    onChange={(v) => settings && void updateSettings({ generation_completion_sound: v })}
                  />
                </label>
                <p className="mt-2 text-xs text-muted">默认开启；可分别关闭，设置自动保存。弹窗显示在应用右上角。</p>
              </div>
              {LEGACY_SETTINGS_ENABLED && <div className="settings-card px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-ink">创作板打开时，Shift + 左键点击素材引入</span>
                  <Toggle
                    label="按住 Shift 引入素材"
                    checked={settings?.board_shift_pick ?? false}
                    disabled={!settings}
                    onChange={(v) =>
                      settings && void updateSettings({ board_shift_pick: v })
                    }
                  />
                </div>
                <p className="mt-1 text-xs text-muted">
                  开启后，在创作板激活期间需按住 Shift
                  再点击素材，才会作为参考素材引入，避免误触；普通左键会弹出菜单，可选择添加到编辑框或打开图片详情。关闭则点击素材直接引入。
                </p>
              </div>}

              {/* 旧版本功能：只隐藏设置入口，历史偏好继续兼容。 */}
              {LEGACY_SETTINGS_ENABLED && <div className="settings-card px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-ink">在画板的全局素材栏中隐藏项目素材</span>
                  <Toggle
                    label="在画板的全局素材栏中隐藏项目素材"
                    checked={settings?.hide_project_assets ?? false}
                    disabled={!settings}
                    onChange={(v) =>
                      settings && void updateSettings({ hide_project_assets: v })
                    }
                  />
                </div>
                <p className="mt-1 text-xs text-muted">
                  控制画板内全局素材栏的显示范围。首页的项目素材由右上角「收起 / 展开」控制，始终可按项目浏览。
                </p>
              </div>}
            </>
          )}

          {section === "about" && (
            <div className="settings-card flex items-center justify-between px-3 py-2.5">
              <span className="text-ink">关于 Bowerbird</span>
              <button
                onClick={() => void open(WEBSITE_URL)}
                className="rounded-md bg-panel px-3 py-1 text-[12px] text-ink hover:bg-edge"
              >
                前往官网 ↗
              </button>
            </div>
          )}

          {section === "developer" && isTestAccount && (
            <>
              <div className="settings-card px-3 py-2.5">
                <div className="text-ink">开发者选项</div>
                <p className="mt-1 text-xs text-muted">
                  仅测试账号可见。集中控制对话框里的 Agent
                  模式开关：默认只开启「Agent」，关闭的模式不会出现在创作板与会话编辑坞
                  （各模式自身的本机 / 云端可用性检查仍照常生效）。
                </p>
              </div>
              <AgentModeCard
                disabled={!settings}
                label="Agent"
                description="正式 Bowerbird Agent（云端 Run）：先只做文字意图分析并给出可审批计划，批准后再执行。默认开启。"
                checked={settings?.agent_mode_enabled ?? true}
                onChange={(v) =>
                  settings && void updateSettings({ agent_mode_enabled: v })
                }
              />
              <AgentModeCard
                disabled={!settings}
                label="Agent A"
                description="dev 方案A（子句挑选）：Agent 按意图从参考图维度原文中挑选子句，确定性拼合后再发送。默认关闭。"
                checked={settings?.agent_a_mode_enabled ?? false}
                onChange={(v) =>
                  settings && void updateSettings({ agent_a_mode_enabled: v })
                }
              />
              <AgentModeCard
                disabled={!settings}
                label="Agent B"
                description="dev 方案B（skill 审查）：Agent 按官方 skill 审查并修复展开后的完整 prompt，再发送。默认关闭。"
                checked={settings?.agent_b_mode_enabled ?? false}
                onChange={(v) =>
                  settings && void updateSettings({ agent_b_mode_enabled: v })
                }
              />
              <AgentModeCard
                disabled={!settings}
                label="Agent Z"
                description="dev：把编辑器内容 + 参考图发到 Claude Code 终端（TUI）对话。默认关闭。"
                checked={settings?.agent_z_mode_enabled ?? false}
                onChange={(v) =>
                  settings && void updateSettings({ agent_z_mode_enabled: v })
                }
              />
              <AgentModeCard
                disabled={!settings}
                label="Agent G"
                description="dev：把编辑器内容 + 参考图发到 codex 终端（TUI）对话。默认关闭。"
                checked={settings?.agent_g_mode_enabled ?? false}
                onChange={(v) =>
                  settings && void updateSettings({ agent_g_mode_enabled: v })
                }
              />
              <AgentModeCard
                disabled={!settings}
                label="Agent DS"
                description="dev：DeepSeek 对话 harness，回复追加到创作板编辑器。默认关闭。"
                checked={settings?.agent_ds_mode_enabled ?? false}
                onChange={(v) =>
                  settings && void updateSettings({ agent_ds_mode_enabled: v })
                }
              />
            </>
          )}
        </div>
      </div>
      {fileMoveOpen && <FileWorkspaceMoveDialog onClose={() => {
        migration.current = null;
        setFileMoveOpen(false);
      }} />}
      {logoutUserId && <AccountLogoutConfirmation userId={logoutUserId} onClose={() => setLogoutUserId(null)} />}
    </ModalShell>
  );
}
