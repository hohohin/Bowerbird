import { save } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { notify, notifyError, notifySuccess } from "./notify";

let exporting = false;

export function exportAssetArchive(assetIds: readonly string[]) {
  return exportSelection(assetIds, "zip");
}

export function exportAssetsToDirectory(assetIds: readonly string[]) {
  return exportSelection(assetIds, "directory");
}

/** Capture the selection before opening the native dialog, including across project switches. */
async function exportSelection(assetIds: readonly string[], format: "zip" | "directory") {
  if (exporting) { notify("正在导出，请稍候"); return; }
  const ids = [...new Set(assetIds)];
  if (!ids.length) return;
  exporting = true;
  try {
    if (format === "zip") {
      const path = await save({ title: "将所选内容打包为压缩包", defaultPath: "所选内容.zip", filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }] });
      if (!path) return;
      notify("正在打包所选内容…");
      const count = await api.exportAssetsZip(ids, path);
      notifySuccess(`已将 ${count} 个文件打包为 ZIP`);
    } else {
      const path = await api.pickFolder(undefined, "选择导出文件夹");
      if (!path) return;
      notify("正在导出所选文件…");
      const count = await api.exportAssetsToDirectory(ids, path);
      notifySuccess(`已将 ${count} 个文件导出到所选文件夹`);
    }
  } catch (error) {
    notifyError(error, format === "zip" ? "打包失败" : "导出失败，请检查原文件和目标文件夹是否可用。");
  } finally {
    exporting = false;
  }
}
