import { Folder } from "lucide-react";
import type { useQuickTransferAddresses } from "../lib/quickTransferDestination";

export type QuickTransferAddresses = ReturnType<typeof useQuickTransferAddresses>;

export function QuickTransferFolder({ directory }: { directory: string | null }) {
  return <div className="quick-transfer-folder">
    <Folder size={18} aria-hidden="true" /><div><span>接收到</span><p title={directory || undefined}>{directory || "Bowerbird Library / 快传"}</p></div>
  </div>;
}

export function QuickTransferNetwork({ network, activeAddress, active, disabled }: {
  network: QuickTransferAddresses; activeAddress: string; active: boolean; disabled: boolean;
}) {
  const { addresses, address, loading } = network;
  const shownAddresses = activeAddress && !addresses.includes(activeAddress) ? [activeAddress, ...addresses] : addresses;
  return <>
    <div className="quick-transfer-network">
      <label htmlFor="quick-transfer-address">局域网地址</label>
      <select id="quick-transfer-address" value={activeAddress || address} disabled={disabled || active || loading || !shownAddresses.length}
        onChange={event => network.setAddress(event.target.value)}>
        {!shownAddresses.length && <option value="">{loading ? "正在查找…" : "无可用地址"}</option>}
        {shownAddresses.map(ip => <option key={ip} value={ip}>{ip}</option>)}
      </select>
      {!active && <button type="button" disabled={disabled || loading} onClick={() => void network.refresh()}>刷新地址</button>}
    </div>
    {!active && !loading && !addresses.length && <p className="quick-transfer-notice">未找到可用的局域网地址，请连接 Wi-Fi 或有线网络后刷新。</p>}
  </>;
}
