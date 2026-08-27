import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-shell";
import { RefreshCw } from "lucide-react";
import { useStore, understandEngineUsable } from "../store";
import { api } from "../lib/api";
import { CODEX_ONBOARDING_ENABLED, DREAMINA_ONBOARDING_ENABLED } from "../lib/featureFlags";
import { DEFAULT_AUTO_ANALYZE_PROMPT, WEBSITE_URL } from "../lib/constants";
import type { MigrateProgress } from "../lib/types";
import { ModalShell } from "./ModalShell";

const STAGE_LABEL: Record<string, string> = {
  images: "复制原图",
  thumbnails: "复制缩略图",
  db: "整理数据库",
};

type SectionKey = "system" | "account" | "models" | "personalization" | "about" | "developer";

/** 即梦 CLI 模型版本选项（dreamina `--model_version`；仅保留 4.7+——image2image 仅 4.0+，
 *  而创作板参考图生成是核心路径；与后端 settings 默认一致取 5.0Pro）。 */
const DREAMINA_MODEL_OPTIONS = ["4.7", "5.0", "5.0Pro"];
const DEFAULT_DREAMINA_MODEL_VERSION = "5.0Pro";

/**
 * 设置项 ON/OFF 滑块开关（设置里的布尔项统一用它，右对齐在调节项右侧；不用复选框）。
 * button + role="switch"，键盘可切换。
 */
function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "bg-accent" : "bg-panel2 hover:bg-edge"
      }`}
    >
      <span
        className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left] ${
          checked ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

/** 开发者选项里的单个 Agent 模式开关卡片（与个性化分区卡片同款形态）。 */
function AgentModeCard({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="settings-card px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-ink">{label}</span>
        <Toggle checked={checked} onChange={onChange} />
      </div>
      <p className="mt-1 text-xs text-muted">{description}</p>
    </div>
  );
}

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "system", label: "系统设置" },
  { key: "account", label: "账号管理" },
  { key: "models", label: "模型设置" },
  { key: "personalization", label: "个性化与记忆" },
  { key: "about", label: "关于我们" },
];

/** 开发者选项分区：仅测试账号（entitlement.is_test_account）追加在导航末尾。 */
const DEVELOPER_SECTION = { key: "developer", label: "开发者选项" } as const;

/**
 * 设置面板（约定 13 全屏 Modal 形态）：常见两列式——左侧分区导航，右侧具体内容。
 *
 * 五分区：系统设置（素材库位置 / 浏览器扩展 / 新手教程）、账号管理（账号名 / 等级与升级 / 积分明细）、
 * 模型设置（codex CLI / 即梦 CLI / 默认反推模型 / 入库自动反推）、个性化与记忆（创作板 Shift 引入
 * / 全局素材隐藏项目素材开关），
 * 关于我们（当前版本 / 前往官网）。原「环境状态」总览已删除，各引导由对应分区直接唤起。
 * 另有「开发者选项」分区仅测试账号可见：对话框 Agent 模式开关集中在此，关闭的模式不在
 * 创作板 / 会话编辑坞渲染（默认只开正式 Agent）。
 * 由侧栏底部账号区「设置」唤起。点背景 / ✕ 关闭。
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const codexHealth = useStore((s) => s.codexHealth);
  const setCodexHealth = useStore((s) => s.setCodexHealth);
  const extensionConnected = useStore((s) => s.extensionConnected);
  const setExtensionOnboardingForceOpen = useStore((s) => s.setExtensionOnboardingForceOpen);
  const setCodexOnboardingForceOpen = useStore((s) => s.setCodexOnboardingForceOpen);
  const setDreaminaOnboardingForceOpen = useStore((s) => s.setDreaminaOnboardingForceOpen);
  const setAccountOnboardingForceOpen = useStore((s) => s.setAccountOnboardingForceOpen);
  const startTour = useStore((s) => s.startTour);
  const settings = useStore((s) => s.settings);
  const loadSettings = useStore((s) => s.loadSettings);
  const updateSettings = useStore((s) => s.updateSettings);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudBusy = useStore((s) => s.cloudBusy);
  const syncCloudEntitlement = useStore((s) => s.syncCloudEntitlement);
  const logoutCloud = useStore((s) => s.logoutCloud);
  const dreaminaHealth = useStore((s) => s.dreaminaHealth);
  const setDreaminaHealth = useStore((s) => s.setDreaminaHealth);
  const defaultUnderstandProvider = useStore((s) => s.defaultUnderstandProvider);
  const setDefaultUnderstandProvider = useStore((s) => s.setDefaultUnderstandProvider);

  const [section, setSection] = useState<SectionKey>("system");
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [checkingCodex, setCheckingCodex] = useState(false);
  const [checkingDreamina, setCheckingDreamina] = useState(false);

  // —— codex「登录授权」一键流程（检测 → 安装 → 浏览器登录）——
  const [codexAuthBusy, setCodexAuthBusy] = useState(false);
  const [codexAuthLine, setCodexAuthLine] = useState<string | null>(null);
  const [codexAuthFailed, setCodexAuthFailed] = useState(false);
  const codexAuthRunningRef = useRef(false);

  // —— dreamina「登录授权」一键流程（检测 → 安装 → 浏览器授权 → checklogin 轮询）——
  const [dreaminaAuthBusy, setDreaminaAuthBusy] = useState(false);
  const [dreaminaAuthLine, setDreaminaAuthLine] = useState<string | null>(null);
  const [dreaminaAuthFailed, setDreaminaAuthFailed] = useState(false);
  const dreaminaAuthRunningRef = useRef(false);

  // 本地编辑态：打开面板时从 store 快照初始化，失焦/按键时写回。
  const [autoAnalyzeOnIngest, setAutoAnalyzeOnIngest] = useState(false);
  const [promptText, setPromptText] = useState("");
  const initialized = useRef(false);

  // —— 素材库位置 ——
  const [libRoot, setLibRoot] = useState<string | null>(null);
  const [migrateTarget, setMigrateTarget] = useState<string | null>(null); // 确认迁移的旧→新
  const [migrating, setMigrating] = useState(false);
  const [migrateProgress, setMigrateProgress] = useState<MigrateProgress | null>(null);
  const [migrateError, setMigrateError] = useState<string | null>(null);

  useEffect(() => {
    api.libraryRoot().then(setLibRoot).catch(() => {});
    getVersion().then(setAppVersion).catch(() => {});
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

  // 「登录授权」进度：安装 / 登录经 codex://setup-progress 推 {stage, line, percent?}，
  // 取最新一行写小字（直装下载带 percent）。仅在授权流程进行中受理（ref 防陈旧闭包）。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen<{ stage: string; line: string; percent?: number | null }>("codex://setup-progress", (e) => {
      if (!codexAuthRunningRef.current) return;
      const pct = typeof e.payload.percent === "number" ? `（${e.payload.percent}%）` : "";
      setCodexAuthFailed(false);
      setCodexAuthLine(`${e.payload.line}${pct}`);
    }).then((u) => (alive ? (unlisten = u) : u()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // 即梦「登录授权」进度：安装经 dreamina://setup-progress 推 {stage, line}（无 percent），
  // 取最新一行写小字。仅在授权流程进行中受理（ref 防陈旧闭包）。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen<{ stage: string; line: string }>("dreamina://setup-progress", (e) => {
      if (!dreaminaAuthRunningRef.current) return;
      setDreaminaAuthFailed(false);
      setDreaminaAuthLine(e.payload.line);
    }).then((u) => (alive ? (unlisten = u) : u()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // store.settings 加载完毕后首充本地状态（仅首次）。
  useEffect(() => {
    if (settings && !initialized.current) return; // 首次由下面这个 effect 填充
    if (settings) {
      setAutoAnalyzeOnIngest(settings.auto_analyze_on_ingest);
      setPromptText(settings.auto_analyze_prompt || DEFAULT_AUTO_ANALYZE_PROMPT);
    }
  }, [settings]);

  const commitSettings = (onIngest: boolean, prompt: string) => {
    // 全量覆盖：只改自动反推两项，其余设置保持不变。
    void updateSettings({
      auto_analyze_on_ingest: onIngest,
      auto_analyze_prompt: prompt || DEFAULT_AUTO_ANALYZE_PROMPT,
      library_root: settings?.library_root ?? null,
      cloud_auto_understand: settings?.cloud_auto_understand ?? false,
      board_shift_pick: settings?.board_shift_pick ?? false,
      hide_project_assets: settings?.hide_project_assets ?? false,
      dreamina_model_version: settings?.dreamina_model_version ?? DEFAULT_DREAMINA_MODEL_VERSION,
      agent_mode_enabled: settings?.agent_mode_enabled ?? true,
      agent_a_mode_enabled: settings?.agent_a_mode_enabled ?? false,
      agent_b_mode_enabled: settings?.agent_b_mode_enabled ?? false,
      agent_z_mode_enabled: settings?.agent_z_mode_enabled ?? false,
      agent_g_mode_enabled: settings?.agent_g_mode_enabled ?? false,
      agent_ds_mode_enabled: settings?.agent_ds_mode_enabled ?? false,
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

  async function recheckCodex() {
    setCheckingCodex(true);
    try {
      setCodexHealth(await api.codexHealth());
    } catch {
      setCodexHealth({ ok: false, reason: "codex 状态检测失败" });
    } finally {
      setCheckingCodex(false);
    }
  }

  /** 「登录授权」一键流程：检测 → 缺 CLI 则自动安装（进度接管小字）→ codex login 开浏览器
   *  走 ChatGPT OAuth。进行中再点为取消（复用 CodexOnboarding 的交互约定）。 */
  async function startCodexAuth() {
    if (codexAuthBusy) {
      void api.cancelCodexSetup();
      return;
    }
    setCodexAuthBusy(true);
    codexAuthRunningRef.current = true;
    setCodexAuthFailed(false);
    setCodexAuthLine("检测环境中…");
    try {
      let h = await api.codexHealth();
      setCodexHealth(h);
      // 未装 CLI（既非就绪也非「已装未登录」）→ 先自动安装。
      if (!h.ok && !h.reason.includes("未登录")) {
        setCodexAuthLine("准备安装 codex CLI…");
        const installed = await api.codexInstall();
        if (!installed.ok) {
          setCodexHealth(installed);
          setCodexAuthFailed(true);
          setCodexAuthLine(installed.reason);
          return;
        }
        h = await api.codexHealth();
        setCodexHealth(h);
      }
      if (h.ok) {
        setCodexAuthLine("已就绪，无需授权");
        return;
      }
      // 已装未登录 → codex login（自己开系统浏览器）。
      const r = await api.codexLogin();
      setCodexHealth(r);
      setCodexAuthFailed(!r.ok);
      setCodexAuthLine(r.ok ? "✓ 授权成功" : r.reason);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("已取消")) setCodexAuthLine(null);
      else {
        setCodexAuthFailed(true);
        setCodexAuthLine(msg);
      }
    } finally {
      codexAuthRunningRef.current = false;
      setCodexAuthBusy(false);
    }
  }

  async function recheckDreamina() {
    setCheckingDreamina(true);
    try {
      // force=true 跳过 120s TTL 缓存：手动「重新检测」要看真实登录态（后端 dreamina_health 约定）。
      setDreaminaHealth(await api.dreaminaHealth(true));
    } catch {
      setDreaminaHealth({ ok: false, reason: "dreamina 状态检测失败" });
    } finally {
      setCheckingDreamina(false);
    }
  }

  /** 即梦「登录授权」一键流程：检测 → 缺 CLI 则自动安装（进度接管小字）→ headless 拿
   *  device flow 自动开浏览器授权 → checklogin 轮询写 token（DreaminaOnboarding 方案 B 同链路）。 */
  async function startDreaminaAuth() {
    if (dreaminaAuthBusy) {
      void api.cancelDreaminaSetup();
      return;
    }
    setDreaminaAuthBusy(true);
    dreaminaAuthRunningRef.current = true;
    setDreaminaAuthFailed(false);
    setDreaminaAuthLine("检测环境中…");
    try {
      let h = await api.dreaminaHealth(true);
      setDreaminaHealth(h);
      // 未装 CLI → 先自动安装。
      if (!h.ok && h.reason.includes("未检测到")) {
        setDreaminaAuthLine("准备安装 dreamina CLI…");
        const installed = await api.dreaminaInstall();
        if (!installed.ok) {
          setDreaminaHealth(installed);
          setDreaminaAuthFailed(true);
          setDreaminaAuthLine(installed.reason);
          return;
        }
        h = await api.dreaminaHealth(true);
        setDreaminaHealth(h);
      }
      if (h.ok) {
        setDreaminaAuthLine("已就绪，无需授权");
        return;
      }
      // 已装未登录 → headless 拿授权链接自动开浏览器，checklogin 轮询等授权完成（约 1 分钟）。
      const flow = await api.dreaminaLoginHeadless();
      try {
        await open(flow.verification_uri);
      } catch {
        setDreaminaAuthLine(`浏览器打开失败，请手动访问：${flow.verification_uri}`);
      }
      setDreaminaAuthLine(
        `请在浏览器完成即梦授权${flow.user_code ? `（授权码 ${flow.user_code}）` : ""}…`,
      );
      const r = await api.dreaminaCheckLogin(flow.device_code);
      setDreaminaHealth(r);
      setDreaminaAuthFailed(!r.ok);
      setDreaminaAuthLine(r.ok ? "✓ 授权成功" : r.reason);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("已取消")) setDreaminaAuthLine(null);
      else {
        setDreaminaAuthFailed(true);
        setDreaminaAuthLine(msg);
      }
    } finally {
      dreaminaAuthRunningRef.current = false;
      setDreaminaAuthBusy(false);
    }
  }

  /** 登出即梦账号：登出入口原本只在 DreaminaOnboarding（入口已暂隐），收敛到卡片小字。 */
  async function logoutDreamina() {
    setDreaminaAuthFailed(false);
    setDreaminaAuthLine("登出中…");
    try {
      await api.dreaminaLogout();
      setDreaminaHealth(await api.dreaminaHealth(true));
      setDreaminaAuthLine(null);
    } catch (e) {
      setDreaminaAuthFailed(true);
      setDreaminaAuthLine(String(e));
    }
  }

  const progress = migrateProgress
    ? STAGE_LABEL[migrateProgress.stage] ?? migrateProgress.stage
    : "";

  // 默认反推模型：非 auto 选项仅在对应引擎当下可用时可选（门控与选择浮层一致）。
  const cloudUsable = understandEngineUsable({ cloudAuth, cloudEntitlement, codexHealth }, "bowerbird-cloud");
  const codexUsable = understandEngineUsable({ cloudAuth, cloudEntitlement, codexHealth }, "codex");
  const understandOptions: { key: string; label: string; ok: boolean; reason?: string }[] = [
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
  const accountName = cloudAuth?.email || cloudAuth?.user_id || "";
  const tier = cloudEntitlement?.tier?.toUpperCase() ?? "FREE";
  const balances = cloudEntitlement?.balances;
  const transactions = cloudEntitlement?.recent_transactions ?? [];
  // 测试账号（bowerbird_test 标记，云端随权益快照下发）才追加「开发者选项」分区。
  const isTestAccount = cloudEntitlement?.is_test_account === true;
  const sections = isTestAccount ? [...SECTIONS, DEVELOPER_SECTION] : SECTIONS;

  return (
    <ModalShell
      title="设置"
      eyebrow="Preferences"
      width="lg"
      preventClose={migrating}
      onClose={onClose}
    >
      {/* 固定高度：不随分区内容多少变化；右列内部滚动 */}
      <div className="flex h-[480px] gap-4 text-sm">
        {/* 左列：分区导航 */}
        <nav className="flex w-36 shrink-0 flex-col gap-0.5 border-r border-edge pr-3" aria-label="设置分区">
          {sections.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSection(s.key)}
              aria-current={section === s.key ? "true" : undefined}
              className={`rounded px-2.5 py-1.5 text-left text-xs ${
                section === s.key
                  ? "bg-accent/15 font-medium text-accent"
                  : "text-muted hover:bg-panel2 hover:text-ink"
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* 右列：具体内容（内容超出时列内滚动） */}
        <div className="min-w-0 flex-1 space-y-3 overflow-y-auto">
          {section === "system" && (
            <>
              {/* 素材库位置 */}
              <div className="settings-card px-3 py-2.5">
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

              {/* 浏览器扩展（原「环境状态」拆出）：状态 + 安装引导 */}
              <div className="settings-card px-3 py-2.5">
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
                    setExtensionOnboardingForceOpen(true);
                    onClose();
                  }}
                  className="mt-2 rounded-md bg-panel px-3 py-1 text-[12px] text-ink hover:bg-edge"
                >
                  {extensionConnected ? "查看引导" : "前往配置"}
                </button>
              </div>

              {/* 新手教程：分步引导（视频/图片教程待补充） */}
              <div className="settings-card px-3 py-2">
                <div className="text-ink">新手教程</div>
                <p className="mt-1 text-xs text-muted">
                    跟着 spotlight 分步引导走一遍导入、复用与创作的核心流程。
                </p>
                <button
                  onClick={() => {
                    startTour();
                    onClose();
                  }}
                  className="mt-2 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-white hover:opacity-90"
                >
                  新手引导
                </button>
              </div>
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
                      {cloudBusy ? "同步中…" : "刷新权益"}
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        setAccountOnboardingForceOpen(true);
                        onClose();
                      }}
                      className="shrink-0 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:opacity-90"
                    >
                      登录 Bowerbird 账号
                    </button>
                  )}
                </div>
                {loggedIn && (
                  <p className="mt-1 text-[11px] text-muted">
                    账号只同步订阅和积分；素材库与本地数据库默认不上传。使用 Cloud / Agent 时，仅本次明确提交的文字和参考图会临时上传。
                  </p>
                )}
              </div>

              {/* 等级 & 升级 */}
              {loggedIn && (
                <div className="settings-card flex items-center justify-between px-3 py-2.5">
                  <span className="text-ink">
                    当前档位：
                    <span className="ml-1 rounded bg-accent/15 px-1.5 py-0.5 text-xs font-semibold text-accent">
                      {tier}
                    </span>
                  </span>
                  <button
                    onClick={() => void open(WEBSITE_URL)}
                    className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:opacity-90"
                    title="打开官网查看订阅方案"
                  >
                    升级
                  </button>
                </div>
              )}

              {/* credits 明细 */}
              {loggedIn && (
                <div className="settings-card px-3 py-2.5">
                  <div className="text-ink">积分明细</div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-center text-[11px]">
                    <div className="rounded-lg border border-edge bg-canvas/70 p-2">
                      <div className="text-muted">每日</div>
                      <div className="mt-0.5 text-sm font-semibold text-ink">{balances?.daily ?? 0}</div>
                    </div>
                    <div className="rounded-lg border border-edge bg-canvas/70 p-2">
                      <div className="text-muted">订阅</div>
                      <div className="mt-0.5 text-sm font-semibold text-ink">{balances?.sub ?? 0}</div>
                    </div>
                    <div className="rounded-lg border border-edge bg-canvas/70 p-2">
                      <div className="text-muted">充值</div>
                      <div className="mt-0.5 text-sm font-semibold text-ink">{balances?.topup ?? 0}</div>
                    </div>
                  </div>
                  {transactions.length > 0 && (
                    <div className="mt-3 border-t border-edge pt-2">
                      <div className="text-[10px] uppercase tracking-wide text-muted">最近积分流水</div>
                      <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto text-[11px]">
                        {transactions.slice(0, 50).map((tx, index) => (
                          <li
                            key={`${tx.created_at}-${index}`}
                            className="flex items-center justify-between gap-2 text-muted"
                          >
                            <span className="truncate">
                              {tx.meta?.entity_type === "agent_run" ? `Agent Run · ${tx.meta.final_status}` : tx.kind}
                              {tx.service ? ` · ${tx.service}` : ""}
                            </span>
                            <span className={tx.amount >= 0 ? "text-green-400" : "text-red-300"}>
                              {tx.amount >= 0 ? `+${tx.amount}` : tx.amount}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <button
                    onClick={() => void logoutCloud()}
                    disabled={cloudBusy}
                    className="mt-3 text-xs text-muted hover:text-red-300 disabled:opacity-50"
                  >
                    登出账号
                  </button>
                </div>
              )}
            </>
          )}

          {section === "models" && (
            <>
              {/* 使用自有 ChatGPT 订阅（codex CLI）：状态 + 一键登录授权；引导弹窗入口随 CODEX_ONBOARDING_ENABLED 暂隐 */}
              <div className="settings-card px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink">使用自有ChatGPT订阅</span>
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        codexHealth?.ok
                          ? "bg-green-500/15 text-green-400"
                          : "bg-red-500/15 text-red-300"
                      }`}
                      title={codexHealth?.reason}
                    >
                      {codexHealth?.ok ? "✓ 就绪" : "✗ 未就绪"}
                    </span>
                    <button
                      type="button"
                      onClick={() => void recheckCodex()}
                      disabled={checkingCodex}
                      title="重新检测"
                      aria-label="重新检测 codex 状态"
                      className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-edge hover:text-ink disabled:opacity-50"
                    >
                      <RefreshCw size={13} className={checkingCodex ? "animate-spin" : undefined} />
                    </button>
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  用 ChatGPT 订阅反推 / 生成 / 命名；仅 Pro / Studio 可用，不配置也不影响本地素材库。
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => void startCodexAuth()}
                    title={codexAuthBusy ? "点击取消当前授权流程" : "自动检测并安装必要配置，随后打开浏览器登录"}
                    className="shrink-0 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:opacity-90"
                  >
                    {codexAuthBusy ? "取消" : "登录授权"}
                  </button>
                  {codexAuthLine && (
                    <span
                      className={`min-w-0 truncate text-[11px] ${
                        codexAuthFailed ? "text-red-300" : "text-muted"
                      }`}
                      title={codexAuthLine}
                    >
                      {codexAuthLine}
                    </span>
                  )}
                </div>
                {CODEX_ONBOARDING_ENABLED && (
                  <button
                    onClick={() => {
                      setCodexOnboardingForceOpen(true);
                      onClose();
                    }}
                    className="mt-2 rounded-md bg-panel px-3 py-1 text-[12px] text-ink hover:bg-edge"
                  >
                    {codexHealth?.ok ? "查看引导" : "前往配置"}
                  </button>
                )}
              </div>

              {/* 使用自有即梦订阅（dreamina CLI）：状态 + 一键登录授权；引导弹窗入口随 DREAMINA_ONBOARDING_ENABLED 暂隐 */}
              <div className="settings-card px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink">使用自有即梦订阅</span>
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        dreaminaHealth?.ok
                          ? "bg-green-500/15 text-green-400"
                          : "bg-red-500/15 text-red-300"
                      }`}
                      title={dreaminaHealth?.reason}
                    >
                      {dreaminaHealth?.ok ? "✓ 就绪" : "✗ 未就绪"}
                    </span>
                    <button
                      type="button"
                      onClick={() => void recheckDreamina()}
                      disabled={checkingDreamina}
                      title="重新检测"
                      aria-label="重新检测即梦状态"
                      className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-edge hover:text-ink disabled:opacity-50"
                    >
                      <RefreshCw size={13} className={checkingDreamina ? "animate-spin" : undefined} />
                    </button>
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  备选出图引擎，使用即梦会员积分；不配置也不影响 codex 出图和本地功能。
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => void startDreaminaAuth()}
                    title={dreaminaAuthBusy ? "点击取消当前授权流程" : "自动检测并安装必要配置，随后打开浏览器授权"}
                    className="shrink-0 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:opacity-90"
                  >
                    {dreaminaAuthBusy ? "取消" : "登录授权"}
                  </button>
                  {dreaminaHealth?.ok && !dreaminaAuthBusy && (
                    <button
                      onClick={() => void logoutDreamina()}
                      title="登出即梦账号（dreamina logout）"
                      className="shrink-0 text-[11px] text-muted hover:text-red-300"
                    >
                      登出
                    </button>
                  )}
                  {dreaminaAuthLine && (
                    <span
                      className={`min-w-0 truncate text-[11px] ${
                        dreaminaAuthFailed ? "text-red-300" : "text-muted"
                      }`}
                      title={dreaminaAuthLine}
                    >
                      {dreaminaAuthLine}
                    </span>
                  )}
                </div>
                {DREAMINA_ONBOARDING_ENABLED && (
                  <button
                    onClick={() => {
                      setDreaminaOnboardingForceOpen(true);
                      onClose();
                    }}
                    className="mt-2 rounded-md bg-panel px-3 py-1 text-[12px] text-ink hover:bg-edge"
                  >
                    {dreaminaHealth?.ok ? "查看引导" : "前往配置"}
                  </button>
                )}
                {/* 即梦模型版本：登录后才显示；每次生成前后端从 settings 重读，修改下一次生成即生效（热切换） */}
                {dreaminaHealth?.ok && (
                  <div className="mt-2 border-t border-edge pt-2">
                    <div className="text-xs text-ink">模型版本</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {DREAMINA_MODEL_OPTIONS.map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() =>
                            settings && void updateSettings({ ...settings, dreamina_model_version: v })
                          }
                          className={`rounded px-2.5 py-1 text-xs ${
                            (settings?.dreamina_model_version ?? DEFAULT_DREAMINA_MODEL_VERSION) === v
                              ? "bg-accent font-medium text-black"
                              : "bg-panel text-ink hover:bg-edge"
                          }`}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* 默认反推模型：非 auto 时跳过每次的引擎选择浮层直接执行 */}
              <div className="settings-card px-3 py-2.5">
                <div className="text-ink">默认反推模型</div>
                <p className="mt-1 text-xs text-muted">
                  选定后反推不再弹引擎选择浮层直接执行；引擎当下不可用时自动退回浮层。
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {understandOptions.map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setDefaultUnderstandProvider(opt.key)}
                      disabled={!opt.ok}
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
                    checked={autoAnalyzeOnIngest}
                    onChange={(v) => {
                      setAutoAnalyzeOnIngest(v);
                      commitSettings(v, promptText);
                    }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted">
                  开启后，新素材入库时自动调用当前账号可用的理解引擎进行反推描述与自动重命名。
                </p>

                {/* 二级选项：提示词文本框 */}
                {autoAnalyzeOnIngest && (
                  <div className="mt-3 ml-6">
                    <label className="text-xs text-muted">自动反推提示词</label>
                    <textarea
                      value={promptText}
                      onChange={(e) => setPromptText(e.target.value)}
                      onBlur={() => commitSettings(autoAnalyzeOnIngest, promptText)}
                      rows={5}
                      className="mt-1 w-full rounded border border-edge bg-panel px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-ink
                        placeholder:text-muted/50 resize-y"
                      placeholder={DEFAULT_AUTO_ANALYZE_PROMPT}
                    />
                    <p className="mt-1 text-[11px] text-muted">
                      可用 <code className="text-[11px]">{`{vocab}`}</code>{" "}
                      表示受控类别词表，运行时会自动替换。
                    </p>
                  </div>
                )}
                {/* 云端理解授权勾选留在「入库时自动反推」里（本质是入库行为开关）。 */}
                <div className="mt-3 flex items-start justify-between gap-2 border-t border-edge pt-2 text-[11px] text-muted">
                  <span className="min-w-0">
                    允许入库自动分析时，把新图片临时发送到 Bowerbird Cloud
                    理解（默认关闭；请求结束不保存图片）
                  </span>
                  <Toggle
                    checked={settings?.cloud_auto_understand ?? false}
                    onChange={(v) =>
                      settings && void updateSettings({ ...settings, cloud_auto_understand: v })
                    }
                    disabled={!cloudAuth?.cloud_available}
                  />
                </div>
              </div>
            </>
          )}

          {section === "personalization" && (
            <>
              <div className="settings-card px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-ink">创作板打开时，Shift + 左键点击素材引入</span>
                  <Toggle
                    checked={settings?.board_shift_pick ?? false}
                    onChange={(v) =>
                      settings && void updateSettings({ ...settings, board_shift_pick: v })
                    }
                  />
                </div>
                <p className="mt-1 text-xs text-muted">
                  开启后，在创作板激活期间需按住 Shift
                  再点击素材，才会作为参考素材引入，避免误触；普通左键会弹出菜单，可选择添加到编辑框或打开图片详情。关闭则点击素材直接引入。
                </p>
              </div>

              <div className="settings-card px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-ink">在全局素材中隐藏项目素材</span>
                  <Toggle
                    checked={settings?.hide_project_assets ?? false}
                    onChange={(v) =>
                      settings && void updateSettings({ ...settings, hide_project_assets: v })
                    }
                  />
                </div>
                <p className="mt-1 text-xs text-muted">
                  开启后，全局素材视图的瀑布流只显示未加入任何项目的素材（搜索、颜色、收藏夹、智能筛选同样生效）；进入项目后仍显示该项目素材。
                </p>
              </div>
            </>
          )}

          {section === "about" && (
            <>
              <div className="settings-card px-3 py-2.5">
                <div className="text-ink">当前版本</div>
                <p className="mt-1 text-xs text-muted">{appVersion ?? "读取中…"}</p>
              </div>
              <div className="settings-card flex items-center justify-between px-3 py-2.5">
                <span className="text-ink">关于 Bowerbird</span>
                <button
                  onClick={() => void open(WEBSITE_URL)}
                  className="rounded-md bg-panel px-3 py-1 text-[12px] text-ink hover:bg-edge"
                >
                  前往官网 ↗
                </button>
              </div>
            </>
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
                label="Agent"
                description="正式 Bowerbird Agent（云端 Run）：先只做文字意图分析并给出可审批计划，批准后再执行。默认开启。"
                checked={settings?.agent_mode_enabled ?? true}
                onChange={(v) =>
                  settings && void updateSettings({ ...settings, agent_mode_enabled: v })
                }
              />
              <AgentModeCard
                label="Agent A"
                description="dev 方案A（子句挑选）：Agent 按意图从参考图维度原文中挑选子句，确定性拼合后再发送。默认关闭。"
                checked={settings?.agent_a_mode_enabled ?? false}
                onChange={(v) =>
                  settings && void updateSettings({ ...settings, agent_a_mode_enabled: v })
                }
              />
              <AgentModeCard
                label="Agent B"
                description="dev 方案B（skill 审查）：Agent 按官方 skill 审查并修复展开后的完整 prompt，再发送。默认关闭。"
                checked={settings?.agent_b_mode_enabled ?? false}
                onChange={(v) =>
                  settings && void updateSettings({ ...settings, agent_b_mode_enabled: v })
                }
              />
              <AgentModeCard
                label="Agent Z"
                description="dev：把编辑器内容 + 参考图发到 Claude Code 终端（TUI）对话。默认关闭。"
                checked={settings?.agent_z_mode_enabled ?? false}
                onChange={(v) =>
                  settings && void updateSettings({ ...settings, agent_z_mode_enabled: v })
                }
              />
              <AgentModeCard
                label="Agent G"
                description="dev：把编辑器内容 + 参考图发到 codex 终端（TUI）对话。默认关闭。"
                checked={settings?.agent_g_mode_enabled ?? false}
                onChange={(v) =>
                  settings && void updateSettings({ ...settings, agent_g_mode_enabled: v })
                }
              />
              <AgentModeCard
                label="Agent DS"
                description="dev：DeepSeek 对话 harness，回复追加到创作板编辑器。默认关闭。"
                checked={settings?.agent_ds_mode_enabled ?? false}
                onChange={(v) =>
                  settings && void updateSettings({ ...settings, agent_ds_mode_enabled: v })
                }
              />
            </>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
