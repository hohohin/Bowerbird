import type { ReactNode, Ref } from "react";
import { RefreshCw } from "lucide-react";

export function SubscriptionCard({
  name, cardRef, status, ready, statusDetail, checkLabel,
  checking, checkDisabled, onCheck, children,
}: {
  name: string;
  cardRef?: Ref<HTMLDivElement>;
  status: string;
  ready?: boolean;
  statusDetail?: string;
  checkLabel: string;
  checking: boolean;
  checkDisabled: boolean;
  onCheck: () => void;
  children: ReactNode;
}) {
  return <div ref={cardRef} tabIndex={-1} data-modal-autofocus={cardRef ? true : undefined}
    role="region" aria-label={`${name} 账号授权`}
    className="settings-card px-3 py-2.5">
    <div className="flex items-center justify-between gap-2">
      <span className="text-ink">{name}</span>
      <span className="flex items-center gap-1.5">
        <span aria-live="polite" title={statusDetail}
          className={`rounded px-2 py-0.5 text-xs ${ready && !checking ? "bg-green-500/15 text-green-400" : "bg-panel2 text-muted"}`}>
          {checking ? "检测中…" : status}
        </span>
        <button type="button" disabled={checkDisabled} onClick={onCheck}
          title="重新检测" aria-label={checkLabel}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-edge hover:text-ink disabled:opacity-50">
          <RefreshCw size={13} className={checking ? "animate-spin" : undefined} aria-hidden="true" />
        </button>
      </span>
    </div>
    {children}
  </div>;
}
