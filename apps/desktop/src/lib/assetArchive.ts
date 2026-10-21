import { save } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { notify, notifyError, notifySuccess } from "./notify";

let exporting = false;

/** Capture the selection before opening the native dialog, including across project switches. */
export async function exportAssetArchive(assetIds: readonly string[]) {
  if (exporting) { notify("正在打包，请稍候"); return; }
  const ids = [...new Set(assetIds)];
  if (!ids.length) return;
  exporting = true;
  try {
    const path = await save({ title: "将所选内容打包", defaultPath: "所选内容.zip", filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }] });
    if (!path) return;
    notify("正在打包所选内容…");
    const count = await api.exportAssetsZip(ids, path);
    notifySuccess(`已将 ${count} 个文件打包为 ZIP`);
  } catch (error) {
    notifyError(error, "打包失败");
  } finally {
    exporting = false;
  }
}
