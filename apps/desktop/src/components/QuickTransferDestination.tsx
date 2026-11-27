import { Folder } from "lucide-react";
import type { useQuickTransferAddresses, useQuickTransferDestinations } from "../lib/quickTransferDestination";
import { quickTransferDestinationKey, type QuickTransferLocation } from "../lib/quickTransferState";
import { TacticalSelect } from "./TacticalSelect";

export type QuickTransferAddresses = ReturnType<typeof useQuickTransferAddresses>;

export function QuickTransferReceiveDestination({ destinations, active, locked, disabled }: {
  destinations: ReturnType<typeof useQuickTransferDestinations>;
  active: QuickTransferLocation | null;
  locked: boolean;
  disabled: boolean;
}) {
  const { options, selected, selectedKey, location, saving, error, select, saveDefault } = destinations;
  const shown = locked ? active : location;
  const saved = options?.defaults.savedFolder;
  const warning = !locked && options?.defaults.warning;
  const folders = options?.folders ?? [];
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const folderOptions = folders.map(folder => {
    const names = [folder.name || folder.path];
    const seen = new Set([folder.id]);
    let parent = folder.parent_id ? byId.get(folder.parent_id) : undefined;
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      names.unshift(parent.name || parent.path);
      parent = parent.parent_id ? byId.get(parent.parent_id) : undefined;
    }
    return { folder, label: names.join(" / ") };
  });
  function change(key: string) {
    const [kind, id] = key.split(":", 2);
    if (kind === "project") select({ kind, projectId: id });
    else if (kind === "folder") select({ kind, folderId: id });
    else select({ kind: "default" });
  }

  return <div className="quick-transfer-folder">
    <Folder size={18} aria-hidden="true" />
    <div className="quick-transfer-folder-details">
      <label htmlFor="quick-transfer-destination">接收到</label>
      <div className="quick-transfer-destination-row">
        <TacticalSelect id="quick-transfer-destination" aria-label="接收到"
          aria-describedby={warning ? "quick-transfer-default-warning" : undefined}
          data-locked={locked || undefined} value={locked ? "active" : options ? selectedKey : ""}
          disabled={locked || disabled || saving || !options} onValueChange={change}>
          {locked ? <option value="active">{active?.name ?? "当前接收落点"}</option> : options ? <>
            <option value="default">默认快传</option>
            {!!options.projects.length && <optgroup label="项目">
              {options.projects.map(project => <option key={project.id} value={quickTransferDestinationKey({ kind: "project", projectId: project.id })}>{project.name}</option>)}
            </optgroup>}
            {!!folderOptions.length && <optgroup label="已连接文件夹">
              {folderOptions.map(({ folder, label }) => <option key={folder.id} value={quickTransferDestinationKey({ kind: "folder", folderId: folder.id })}
                title={folder.path} disabled={!folder.available && quickTransferDestinationKey(options.defaults.effective) !== `folder:${folder.id}`}>
                {folder.id === saved?.folderId ? `${label}（默认）` : label}
              </option>)}
            </optgroup>}
          </> : <option value="">{error ? "暂时无法读取" : "正在读取…"}</option>}
        </TacticalSelect>
        {!locked && shown?.kind === "folder" && selected.kind === "folder" && selected.folderId !== saved?.folderId &&
          <button type="button" disabled={disabled || saving} onClick={() => void saveDefault(selected.folderId)}>设为默认</button>}
        {!locked && saved && <button type="button" disabled={disabled || saving} onClick={() => void saveDefault(null)}>恢复默认快传</button>}
      </div>
      {shown && <p className="quick-transfer-destination-path" title={shown.directory}>{shown.directory}</p>}
      {warning && <p id="quick-transfer-default-warning" className="quick-transfer-notice" role="status">{warning}</p>}
      {!locked && error && <p className="quick-transfer-error" role="alert">{error}</p>}
    </div>
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
