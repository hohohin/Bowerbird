import { useState } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, QrCode } from "lucide-react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { useStore } from "../store";
import { ModalShell } from "./ModalShell";
import brandIcon from "../../src-tauri/icons/128x128.png";

export function OnboardingCompletion({ onComplete, onPrevious, onSkip, disabled, error, stepNumber, totalSteps }: {
  onComplete: () => void; onPrevious: () => void; onSkip: () => void; disabled: boolean; error: string;
  stepNumber: number; totalSteps: number;
}) {
  const auth = useStore(state => state.cloudAuth);
  const busy = useStore(state => state.cloudBusy);
  const startWechatLogin = useStore(state => state.startCloudWechatLogin);
  const [opening, setOpening] = useState(false);
  const [started, setStarted] = useState(false);
  const [loginError, setLoginError] = useState("");

  async function login() {
    if (opening || busy) return;
    setOpening(true); setStarted(false); setLoginError("");
    try {
      const url = await startWechatLogin();
      await openExternal(url);
      setStarted(true);
    } catch (cause) {
      setLoginError(typeof cause === "string" ? cause : cause instanceof Error ? cause.message : "扫码登录未能打开，请重试。");
    } finally { setOpening(false); }
  }

  return <ModalShell title="入门引导已完成" eyebrow={`设计师 · ${stepNumber}/${totalSteps}`} width="lg"
    className="onboarding-completion"
    onClose={onComplete}
    headerActions={<>
      <button className="app-modal-close" aria-label="上一步" title="上一步" disabled={disabled} onClick={onPrevious}><ArrowLeft size={20} /></button>
      <button className="app-modal-close" aria-label="跳过此步" title="跳过此步" disabled={disabled} onClick={onSkip}><ArrowRight size={20} /></button>
    </>}
    footer={<button className="app-modal-button is-primary" disabled={disabled} onClick={onComplete}>完成本次引导</button>}>
    <div className="onboarding-completion-grid">
      <section className="onboarding-completion-message">
        <img className="onboarding-brand" src={brandIcon} alt="园丁鸟" />
        <h3>恭喜你，已完成设计师入门引导！</h3>
        <p>现在你已经准备好生成了，开始筑巢吧。</p>
        <p>你也可以随时从入门引导中选择其他身份，继续了解园丁鸟。</p>
        {error && <p role="alert" className="app-inline-status is-error">{error}</p>}
      </section>
      <section className="onboarding-completion-login" aria-label="扫码登录">
        {auth?.logged_in ? <>
          <CheckCircle2 size={36} aria-hidden />
          <h3>已登录，开始创作吧</h3>
          <p>{auth.display_name || auth.email || "你的园丁鸟账号已准备就绪。"}</p>
        </> : <>
          <QrCode size={36} aria-hidden />
          <h3>微信扫码登录</h3>
          <p>登录以使用园丁鸟创作功能。</p>
          <p>在系统浏览器打开二维码，使用微信扫码确认后自动返回应用。</p>
          <button type="button" className="app-modal-button is-primary" disabled={opening || busy || !auth?.cloud_available} onClick={() => void login()}>
            {(opening || busy) && <span className="app-spinner" aria-hidden />}
            {started ? "重新打开微信扫码登录" : "使用微信扫码登录"}
          </button>
          {started && <p role="status">已打开二维码，请用微信扫码确认。</p>}
          {auth && !auth.cloud_available && <p role="status">当前版本未配置登录服务，请安装官方构建。</p>}
          {loginError && <p role="alert" className="app-inline-status is-error">{loginError}</p>}
        </>}
      </section>
    </div>
  </ModalShell>;
}
