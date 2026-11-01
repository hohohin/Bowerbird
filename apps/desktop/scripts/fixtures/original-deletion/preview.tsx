await import("../asset-multi-menu/preview");
const w = window as any;
const original = w.__TAURI_INTERNALS__.invoke;
w.trashCalls = []; w.notices = [];
window.addEventListener("bowerbird://notify", (event: any) => w.notices.push(event.detail));
w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
  if (command === "preview_asset_originals") {
    if (w.failPreview) throw new Error("原文件暂时无法读取，请重试。");
    return args.assetIds.map((id: string) => ({ asset_id: id, name: `disk-${id}.png`,
      path: `D:/素材/${w.samePath ? "same" : id}.png`, fingerprint: `version-${id}` }));
  }
  if (command === "trash_asset_original") {
    w.trashCalls.push(args.original);
    if (w.holdTrash) await new Promise(resolve => { w.releaseTrash = resolve; });
    if (args.original.asset_id === w.failId) throw new Error("文件正被使用，请关闭后重试。");
    return null;
  }
  return original(command, args);
};
w.ready = true;
export {};
