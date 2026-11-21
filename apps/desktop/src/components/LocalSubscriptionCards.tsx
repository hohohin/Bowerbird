import { useCallback, useEffect, useState, type Ref } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { useStore } from "../store";
import { api } from "../lib/api";
import type { DreaminaHealth, SettingsRequest } from "../lib/types";
import { userErrorMessage } from "../lib/userError";
import { CODEX_ONBOARDING_ENABLED, DREAMINA_ONBOARDING_ENABLED } from "../lib/featureFlags";
import { SubscriptionCard } from "./SubscriptionCard";
import { useSubscriptionOperation } from "./useSubscriptionOperation";

export function useLocalSubscriptions() {
  const codexHealth = useStore(s => s.codexHealth);
  const setCodexHealth = useStore(s => s.setCodexHealth);
  const dreaminaHealth = useStore(s => s.dreaminaHealth);
  const setDreaminaHealth = useStore(s => s.setDreaminaHealth);
  const codex = useSubscriptionOperation("codex://setup-progress", api.cancelCodexSetup);
  const dreamina = useSubscriptionOperation("dreamina://setup-progress", api.cancelDreaminaSetup);
  const [userCode, setUserCode] = useState("");
  const { run: runCodex, mounted: codexMounted } = codex;
  const { run: runDreamina, mounted: dreaminaMounted } = dreamina;

  const checkCodex = useCallback(() => runCodex("check", async () => {
    const health = await api.codexHealth().catch(() => ({ ok: false, reason: "暂时无法检测 Codex，请重新检测。" }));
    if (codexMounted.current) setCodexHealth(health);
  }), [runCodex, codexMounted, setCodexHealth]);
  const checkDreamina = useCallback(() => runDreamina("check", async () => {
    const health = await api.dreaminaHealth(true).catch((): DreaminaHealth =>
      ({ ok: false, status: "unconfirmed", reason: "即梦状态检测失败，请重新检测。" }));
    if (dreaminaMounted.current) setDreaminaHealth(health);
  }), [runDreamina, dreaminaMounted, setDreaminaHealth]);

  useEffect(() => { void checkCodex(); void checkDreamina(); }, [checkCodex, checkDreamina]);

  function authorizeCodex() {
    if (codex.busy === "auth") return codex.cancel();
    void runCodex("auth", async () => {
      codex.setLine("检测环境中…");
      try {
        let health = await api.codexHealth();
        setCodexHealth(health);
        if (codex.cancellation.current) return;
        if (!health.ok && !health.reason?.includes("未登录")) {
          codex.setLine("准备安装 Codex CLI…");
          const installed = await api.codexInstall();
          if (!installed.ok) throw installed.reason;
          health = await api.codexHealth();
          setCodexHealth(health);
          if (codex.cancellation.current) return;
        }
        if (health.ok) {
          codex.setLine("已登录，可先退出登录以更换账号。");
          return;
        }
        const result = await api.codexLogin();
        setCodexHealth(result);
        if (!result.ok) throw result.reason;
        codex.setLine("授权成功");
      } catch (error) {
        if (codex.cancellation.current) return;
        codex.setFailed(true);
        codex.setLine(userErrorMessage(error, "Codex 安装或授权未完成，请重试。"));
      }
    });
  }

  function logoutCodex() {
    void runCodex("logout", async () => {
      codex.setLine("正在退出登录…");
      try {
        setCodexHealth(await api.codexLogout());
        codex.setLine("已退出登录");
      } catch (error) {
        codex.setFailed(true);
        codex.setLine(userErrorMessage(error, "退出登录未完成，请重试。"));
      }
    });
  }

  function authorizeDreamina() {
    if (dreamina.busy === "auth") return dreamina.cancel();
    void runDreamina("auth", async () => {
      dreamina.setLine("检测环境中…");
      try {
        let health = await api.dreaminaHealth(true);
        setDreaminaHealth(health);
        if (dreamina.cancellation.current) return;
        if (health.status === "missing") {
          dreamina.setLine("准备安装即梦 CLI…");
          const installed = await api.dreaminaInstall();
          if (!installed.ok) throw installed.reason;
          health = await api.dreaminaHealth(true);
          setDreaminaHealth(health);
          if (dreamina.cancellation.current) return;
        }
        if (health.ok) {
          dreamina.setLine("已登录，可先退出登录以更换账号。");
          return;
        }
        if (health.status !== "login_required") throw health.reason;
        const flow = await api.dreaminaLoginHeadless();
        if (dreamina.cancellation.current) return;
        if (flow) {
          await open(flow.verification_uri).catch(() => {
            throw new Error("未能打开即梦授权网页，请检查系统默认浏览器后重试。");
          });
          if (dreamina.cancellation.current) return;
          setUserCode(flow.user_code);
          dreamina.setLine("请在浏览器完成即梦授权。");
        }
        const result = flow ? await api.dreaminaCheckLogin(flow.device_code) : await api.dreaminaHealth(true);
        setDreaminaHealth(result);
        if (!result.ok) throw result.reason;
        dreamina.setLine("授权成功");
      } catch (error) {
        if (dreamina.cancellation.current) return;
        dreamina.setFailed(true);
        dreamina.setLine(userErrorMessage(error, "即梦安装或授权未完成，请重试。"));
      } finally {
        setUserCode("");
      }
    });
  }

  function logoutDreamina() {
    void runDreamina("logout", async () => {
      dreamina.setLine("正在退出登录…");
      try {
        await api.dreaminaLogout();
        setDreaminaHealth({ ok: false, status: "login_required", reason: "请登录即梦账号。" });
        dreamina.setLine("已退出登录");
      } catch (error) {
        dreamina.setFailed(true);
        dreamina.setLine(userErrorMessage(error, "退出登录未完成，请重试。"));
      }
    });
  }

  return {
    codexHealth, dreaminaHealth, codex, dreamina, userCode, checkCodex, checkDreamina,
    authorizeCodex, authorizeDreamina, logoutCodex, logoutDreamina,
  };
}

export function LocalSubscriptionCards({ subscriptions, target, cardRef, onOpenGuide }: {
  subscriptions: ReturnType<typeof useLocalSubscriptions>;
  target: SettingsRequest["subscription"];
  cardRef: Ref<HTMLDivElement>;
  onOpenGuide: (target: "codex" | "jimeng") => void;
}) {
  const { codexHealth, dreaminaHealth, codex, dreamina, userCode } = subscriptions;
  const codexStatus = codexHealth?.ok ? "✓ 就绪"
    : codexHealth?.reason?.includes("未登录") ? "未登录"
    : codexHealth?.reason?.includes("未检测到可用") ? "未安装"
    : codexHealth ? "登录状态待确认" : "待检测";
  const dreaminaStatus = dreaminaHealth ? {
    ready: "✓ 就绪", login_required: "未登录", missing: "未安装", unconfirmed: "登录状态待确认",
  }[dreaminaHealth.status] ?? (dreaminaHealth.ok ? "✓ 就绪" : "登录状态待确认") : "待检测";

  return <>
    <SubscriptionCard name="ChatGPT" cardRef={target === "codex" ? cardRef : undefined} status={codexStatus}
      ready={codexHealth?.ok} statusDetail={codexHealth?.reason ? userErrorMessage(codexHealth.reason, "请重新检测或登录。") : undefined}
      checkLabel="重新检测 Codex 状态" checking={codex.busy === "check"} checkDisabled={!!codex.busy} onCheck={subscriptions.checkCodex}>
      <p className="mt-1 text-xs text-muted">使用 ChatGPT 订阅反推、生成或命名，需要 Pro 或 Studio。可退出登录以更换账号。</p>
      <SubscriptionActions operation={codex} ready={codexHealth?.ok} signedIn={codexHealth?.signed_in ?? codexHealth?.ok}
        onAuthorize={subscriptions.authorizeCodex} onLogout={subscriptions.logoutCodex} />
      {CODEX_ONBOARDING_ENABLED && <button type="button" className="mt-2 text-xs text-ink underline" disabled={!!codex.busy}
        onClick={() => onOpenGuide("codex")}>查看引导</button>}
    </SubscriptionCard>
    <SubscriptionCard name="即梦" cardRef={target === "jimeng" ? cardRef : undefined} status={dreaminaStatus}
      ready={dreaminaHealth?.ok} statusDetail={dreaminaHealth?.reason ? userErrorMessage(dreaminaHealth.reason, "请重新检测或登录。") : undefined}
      checkLabel="重新检测即梦状态" checking={dreamina.busy === "check"} checkDisabled={!!dreamina.busy} onCheck={subscriptions.checkDreamina}>
      <p className="mt-1 text-xs text-muted">使用即梦会员积分生成图片和视频，需要 Pro 或 Studio。</p>
      <SubscriptionActions operation={dreamina} ready={dreaminaHealth?.ok} signedIn={dreaminaHealth?.ok || dreaminaHealth?.status === "unconfirmed"}
        onAuthorize={subscriptions.authorizeDreamina} onLogout={subscriptions.logoutDreamina} userCode={userCode} />
      {DREAMINA_ONBOARDING_ENABLED && <button type="button" className="mt-2 text-xs text-ink underline" disabled={!!dreamina.busy}
        onClick={() => onOpenGuide("jimeng")}>查看引导</button>}
    </SubscriptionCard>
  </>;
}

function SubscriptionActions({ operation, ready, signedIn, onAuthorize, onLogout, userCode }: {
  operation: ReturnType<typeof useSubscriptionOperation>;
  ready?: boolean;
  signedIn?: boolean;
  onAuthorize: () => void;
  onLogout: () => void;
  userCode?: string;
}) {
  const authorizing = operation.busy === "auth";
  return <>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {(!ready || authorizing) && <button type="button" className="app-modal-button is-primary"
        disabled={operation.cancelling || (!!operation.busy && !authorizing)} onClick={onAuthorize}>
        {operation.cancelling ? "正在取消…" : authorizing ? "取消授权" : "登录授权"}
      </button>}
      {signedIn && <button type="button" className="app-modal-button" disabled={!!operation.busy} onClick={onLogout}>
        {operation.busy === "logout" ? "退出中…" : "退出登录"}
      </button>}
    </div>
    {operation.line && <p role={operation.failed ? "alert" : "status"} className={`mt-1 text-xs ${operation.failed ? "text-red-300" : "text-muted"}`}>
      {userErrorMessage(operation.line, operation.failed ? "操作未完成，请重试。" : "正在准备授权，请稍候…")}
      {userCode && <span className="ml-1 select-text font-mono">{userCode}</span>}
    </p>}
  </>;
}
