import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Info, Smartphone, X } from "lucide-react";
import { useQuickTransfer } from "../lib/useQuickTransfer";
import { useQuickTransferAddresses, useQuickTransferDirectory } from "../lib/quickTransferDestination";
import { userErrorMessage } from "../lib/userError";
import { ModalShell } from "./ModalShell";
import { OverlayScrollArea } from "./CollectionScrollArea";
import { QuickTransferFolder, QuickTransferNetwork } from "./QuickTransferDestination";
import { QuickTransferConnection } from "./QuickTransferConnection";
import { QuickTransferQueue } from "./QuickTransferQueue";
import { QuickTransferSend } from "./QuickTransferSend";
import "./QuickTransferPanel.css";

function QuickTransferTrigger({ active, visible, onOpen }: { active: boolean; visible: boolean; onOpen: () => void }) {
  return <button type="button" className={`app-button-dark quick-transfer-trigger${active ? " is-receiving" : ""}`}
    aria-label="快传" aria-haspopup="dialog" aria-expanded={visible} onClick={onOpen} title={active ? "快传已开启" : "快传"}>
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

function QuickTransferTabs({ mode, onChange, receiving, sending }: {
  mode: "receive" | "send"; onChange: (mode: "receive" | "send") => void; receiving: boolean; sending: boolean;
}) {
  return <div className="quick-transfer-tabs" role="tablist" aria-label="快传方向" onKeyDown={event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === "Home" ? 0 : event.key === "End" ? 1 : mode === "receive" ? 1 : 0;
    const button = event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[index];
    button.click(); button.focus();
  }}>
    <button id="quick-transfer-receive-tab" type="button" role="tab" aria-controls="quick-transfer-body" tabIndex={mode === "receive" ? 0 : -1} aria-selected={mode === "receive"} onClick={() => onChange("receive")}>接收{receiving && <i aria-hidden="true" />}</button>
    <button id="quick-transfer-send-tab" type="button" role="tab" aria-controls="quick-transfer-body" tabIndex={mode === "send" ? 0 : -1} aria-selected={mode === "send"} onClick={() => onChange("send")}>发送{sending && <i aria-hidden="true" />}</button>
  </div>;
}

/** One persistent toolbar owner: closing the modal never changes the native receiver. */
export function QuickTransfer({ showTrigger = true }: { showTrigger?: boolean }) {
  const transfer = useQuickTransfer();
  const { snapshot, ready, busy } = transfer;
  const [visible, setVisible] = useState(false);
  const [localError, setLocalError] = useState("");
  const [mode, setMode] = useState<"receive" | "send">("receive");
  const [paths, setPaths] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const blocked = !!busy || !ready || picking;
  const directory = useQuickTransferDirectory(visible, setLocalError);
  const network = useQuickTransferAddresses(visible, setLocalError);
  const disabled = blocked;
  const sending = mode === "send";
  const activeUrl = sending ? snapshot.sending?.url ?? null : snapshot.active ? snapshot.url : null;
  const activeAddress = activeUrl ? new URL(activeUrl).hostname : "";
  const cannotStart = !network.address || network.loading;

  async function pickFiles() {
    setPicking(true); setLocalError("");
    try {
      const result = await open({ multiple: true, directory: false, title: "选择要发送的文件" });
      if (result) setPaths(current => [...new Set([...current, ...(Array.isArray(result) ? result : [result])])]);
    } catch (error) { setLocalError(userErrorMessage(error, "未能选择文件，请重试。")); }
    finally { setPicking(false); }
  }

  function toggle() {
    setLocalError("");
    if (snapshot.active) void transfer.stop();
    else void transfer.start(network.address);
  }

  return <>
    {showTrigger && <QuickTransferTrigger active={snapshot.active || !!snapshot.sending} visible={visible} onOpen={() => setVisible(true)} />}
    {visible && <ModalShell title="快传" width="md" className="quick-transfer-panel" showCloseButton={false} onClose={() => setVisible(false)}
      headerActions={<button type="button" className="app-modal-close" aria-label="收起快传面板" title="收起面板，继续快传" onClick={() => setVisible(false)}><X size={17} /></button>}>
      <OverlayScrollArea className="quick-transfer-scroll" contentClassName="quick-transfer-content" label="快传列表滚动条">
        <QuickTransferTabs mode={mode} onChange={next => { setMode(next); setLocalError(""); }} receiving={snapshot.active} sending={!!snapshot.sending} />
        <div id="quick-transfer-body" role="tabpanel" aria-labelledby={`quick-transfer-${mode}-tab`}>
        {sending ? <QuickTransferSend sending={snapshot.sending} paths={paths} disabled={disabled} canStart={!cannotStart && paths.length > 0}
          onPick={() => void pickFiles()} onRemove={path => setPaths(current => current.filter(item => item !== path))}
          onStart={() => void transfer.startSend(network.address, paths)} onStop={() => void transfer.stopSend()} /> : <>
        <QuickTransferSwitch active={snapshot.active} ready={ready} busy={busy} disabled={disabled || (!snapshot.active && cannotStart)} onToggle={toggle} />
        <QuickTransferFolder directory={snapshot.active ? snapshot.directory : directory} />
        </>}
        <QuickTransferNetwork network={network} activeAddress={activeAddress} active={!!activeUrl} disabled={disabled} />
        <QuickTransferError error={localError || transfer.error} ready={ready} reconnect={transfer.reconnect} />
        <QuickTransferConnection url={activeUrl} onError={setLocalError} sending={sending} />
        {!sending && <QuickTransferQueue files={snapshot.transfers} active={snapshot.active} canRetry={snapshot.active && !disabled} retry={transfer.retry} />}
        <p className="quick-transfer-bottom"><Info size={13} aria-hidden="true" />仅在可信局域网使用 · HTTP 未加密</p>
        </div>
      </OverlayScrollArea>
    </ModalShell>}
  </>;
}
