import type { ProviderIssue } from "../../lib/generationAvailability";
import { useStore } from "../../store";

export function openProviderSettings(target: NonNullable<ProviderIssue["settings"]>) {
  if (target === "account") useStore.getState().setAccountOnboardingForceOpen(true);
  else useStore.setState({ subscriptionSettingsTarget: target });
}

export function ProviderIssueNotice({ issue, className = "" }: { issue: ProviderIssue | null; className?: string }) {
  if (!issue) return null;
  const { message, settings } = issue;
  return <span role="status" className={`text-xs text-muted ${className}`}>
    {message}
    {settings && <button type="button" className="ml-1 text-ink underline underline-offset-2"
      onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); openProviderSettings(settings); }}>
      {settings === "account" ? "查看账号" : "配置自有订阅"}
    </button>}
  </span>;
}
