import { useStore } from "../store";

/**
 * 扩展连接状态指示器（一个圆点），挂在工具栏（CodexStatus 旁）。
 *
 * 绿 = 扩展已连（最近 30s 收到过心跳 / 采集）；灰 = 未连。
 * 状态来自 store `extensionConnected`（App 挂载取一次 + listen
 * `collect://extension-connected` / `collect://extension-disconnected`）。
 * 点灰点重弹 ExtensionOnboarding（让用户随时能找回安装引导，不只首启）。
 */
export function ExtensionStatus() {
  const connected = useStore((s) => s.extensionConnected);
  const setForceOpen = useStore((s) => s.setExtensionOnboardingForceOpen);

  if (connected) {
    return (
      <div
        className="h-3 w-3 rounded-full bg-green-400"
        title="浏览器扩展已连接"
        aria-label="浏览器扩展已连接"
      />
    );
  }
  return (
    <button
      onClick={() => setForceOpen(true)}
      className="h-3 w-3 rounded-full border-2 border-muted/50 hover:border-muted"
      title="浏览器扩展未连接，点击查看安装引导"
      aria-label="浏览器扩展未连接，点击查看安装引导"
    />
  );
}
