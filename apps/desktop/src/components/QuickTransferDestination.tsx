import { Folder } from "lucide-react";
import type { useQuickTransferAddresses, useQuickTransferDirectory } from "../lib/quickTransferDestination";

export type QuickTransferDirectory = ReturnType<typeof useQuickTransferDirectory>;
export type QuickTransferAddresses = ReturnType<typeof useQuickTransferAddresses>;

export function QuickTransferFolder({ folder, active, disabled }: { folder: QuickTransferDirectory; active: boolean; disabled: boolean }) {
  return <div className="quick-transfer-folder">
    <Folder size={18} aria-hidden="true" /><div><span>接收到</span><p title={folder.directory}>{folder.directory || "选择文件夹保存收到的素材"}</p></div>
    <button type="button" disabled={disabled || active} onClick={() => void folder.choose()} title={active ? "关闭接收后可更改文件夹" : undefined}>
      {folder.choosing ? "选择中…" : folder.directory ? "更改" : "选择文件夹"}
    </button>
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
