import { useState } from "react";
import { Info, Smartphone, X } from "lucide-react";
import { useQuickTransfer } from "../lib/useQuickTransfer";
import { useQuickTransferAddresses, useQuickTransferDirectory } from "../lib/quickTransferDestination";
import { userErrorMessage } from "../lib/userError";
import { ModalShell } from "./ModalShell";
import { OverlayScrollArea } from "./CollectionScrollArea";
import { QuickTransferFolder, QuickTransferNetwork } from "./QuickTransferDestination";
import { QuickTransferConnection } from "./QuickTransferConnection";
import { QuickTransferQueue } from "./QuickTransferQueue";
import "./QuickTransferPanel.css";

function QuickTransferTrigger({ active, visible, onOpen }: { active: boolean; visible: boolean; onOpen: () => void }) {
  return <button type="button" className={`app-button-dark quick-transfer-trigger${active ? " is-receiving" : ""}`}
    aria-label="快传" aria-haspopup="dialog" aria-expanded={visible} onClick={onOpen} title={active ? "快传正在接收" : "快传"}>
    <Smartphone size={15} /><span className="app-topbar-button-label">快传</span>
    {active && <i aria-hidden="true" />}
  </button>;
}

const PENDING_LABELS: Record<string, string> = { quick_transfer_start: "正在开启…", quick_transfer_stop: "正在关闭…" };
function QuickTransferSwitch({ active, ready, busy, disabled, onToggle }: {
  active: boolean; ready: boolean; busy: string; disabled: boolean; onToggle: () => void;
}) {
  const status = ready ? (active ? "接收已开启" : "接收已关闭") : "正在读取状态";
  const action = PENDING_LABELS[busy] ?? (active ? "关闭接收" : "开启接收");
  return <div className="quick-transfer-status">
    <span className={`quick-transfer-live${active ? " is-active" : ""}`}><i />{status}</span>
    <button type="button" className="quick-transfer-switch" role="switch" aria-label="接收开关" aria-checked={active} disabled={disabled} onClick={onToggle}>
      <span>{action}</span><i aria-hidden="true" />
    </button>
  </div>;
}

function QuickTransferError({ error, ready, reconnect }: { error: string; ready: boolean; reconnect: () => void }) {
  if (!error) return null;
  return <div className="quick-transfer-error" role="alert">{userErrorMessage(error, "快传操作未完成，请查看状态后重试。")}
    {!ready && <button type="button" onClick={reconnect}>重新读取</button>}</div>;
}

/** One persistent toolbar owner: closing the modal never changes the native receiver. */
export function QuickTransfer({ showTrigger = true }: { showTrigger?: boolean }) {
  const transfer = useQuickTransfer();
  const { snapshot, ready, busy } = transfer;
  const [visible, setVisible] = useState(false);
  const [localError, setLocalError] = useState("");
  const blocked = !!busy || !ready;
  const directory = useQuickTransferDirectory(visible, setLocalError);
  const network = useQuickTransferAddresses(visible, setLocalError);
  const disabled = blocked;
  const activeUrl = snapshot.active ? snapshot.url : null;
  const activeAddress = activeUrl ? new URL(activeUrl).hostname : "";
  const cannotStart = !network.address || network.loading;

  function toggle() {
    setLocalError("");
    if (snapshot.active) void transfer.stop();
    else void transfer.start(network.address);
  }

  return <>
    {showTrigger && <QuickTransferTrigger active={snapshot.active} visible={visible} onOpen={() => setVisible(true)} />}
    {visible && <ModalShell title="快传" width="md" className="quick-transfer-panel" showCloseButton={false} onClose={() => setVisible(false)}
      headerActions={<button type="button" className="app-modal-close" aria-label="收起快传面板" title="收起面板，继续接收" onClick={() => setVisible(false)}><X size={17} /></button>}>
      <OverlayScrollArea className="quick-transfer-scroll" contentClassName="quick-transfer-content" label="快传接收列表滚动条">
        <QuickTransferSwitch active={snapshot.active} ready={ready} busy={busy} disabled={disabled || (!snapshot.active && cannotStart)} onToggle={toggle} />
        <QuickTransferFolder directory={snapshot.active ? snapshot.directory : directory} />
        <QuickTransferNetwork network={network} activeAddress={activeAddress} active={snapshot.active} disabled={disabled} />
        <QuickTransferError error={localError || transfer.error} ready={ready} reconnect={transfer.reconnect} />
        <QuickTransferConnection url={activeUrl} onError={setLocalError} />
        <QuickTransferQueue files={snapshot.transfers} active={snapshot.active} canRetry={snapshot.active && !disabled} retry={transfer.retry} />
        <p className="quick-transfer-bottom"><Info size={13} aria-hidden="true" />仅在可信局域网使用 · HTTP 未加密</p>
      </OverlayScrollArea>
    </ModalShell>}
  </>;
}
