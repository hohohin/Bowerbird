import "../canvas-reference/preview";

// Reuse the real CanvasWorkspace fixture. This wrapper is closed synthetic IPC:
// every asset is an SVG data URL and all preference writes stay in this tab.
const w = window as any;
const store = w.store;
const counts = [18, 4, 3, 0, 0];
const names = ["最高频素材", "四次边界素材", "三次边界素材", "手动素材甲", "手动素材乙"];
const assets = store.getState().assets.map((asset: any, index: number) => ({
  ...asset, name: names[index], ext: "svg", reference_count: counts[index], created_at: index + 1,
  thumb_path: asset.store_path, library_hidden: false,
}));
assets.push(...Array.from({ length: 12 }, (_, index) => ({
  ...assets[0], id: `frequent-${index}`, name: `横向素材 ${index + 1}`, reference_count: 17 - index, created_at: 100 + index,
})), { ...assets[0], id: "hidden", name: "隐藏高频素材", reference_count: 99, library_hidden: true });
const storageKey = "canvas-frequent-assets-preferences";
let preferences: { pinned: string[]; excluded: string[]; threshold: number } = { threshold: 10, ...JSON.parse(sessionStorage.getItem(storageKey) || '{"pinned":[],"excluded":[]}') };
const members: Record<string, string[]> = { p: ["existing", "a", "c", "hidden", "frequent-0", "frequent-1"], q: ["b", "d"] };
const inScope = (asset: any, projectId?: string | null) => !projectId || members[projectId]?.includes(asset.id);
const visible = (projectId?: string | null) => assets.filter((asset: any) => !asset.library_hidden && inScope(asset, projectId));
const result = (projectId?: string | null) => ({
  threshold: preferences.threshold,
  frequent: visible(projectId).filter((asset: any) => asset.reference_count > preferences.threshold && !preferences.excluded.includes(asset.id))
    .sort((a: any, b: any) => b.reference_count - a.reference_count || b.created_at - a.created_at || a.id.localeCompare(b.id)),
  pinned: preferences.pinned.map(id => assets.find((asset: any) => asset.id === id && inScope(asset, projectId))).filter(Boolean),
});
const persist = () => sessionStorage.setItem(storageKey, JSON.stringify(preferences));
const baseInvoke = w.__TAURI_INTERNALS__.invoke;
const baseSnapshot = w.snapshot;
const withHiddenNode = (snapshot: any) => {
  if (snapshot.canvas.projectId === "p" && !snapshot.nodes.some((node: any) => node.id === "hidden-node")) {
    snapshot.nodes.push({ ...snapshot.nodes[0], id: "hidden-node", assetId: "hidden", x: 1000, y: 300, threadId: null,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: "隐藏高频素材", width: 190, height: 150 } }) });
  }
  return snapshot;
};
w.snapshot = () => withHiddenNode(baseSnapshot());
w.frequentAssets = assets;
w.frequentMembers = members;
w.frequentPreferences = () => structuredClone(preferences);
w.frequentResult = (projectId?: string) => structuredClone(result(projectId));
w.picked = [];
w.addEventListener("bowerbird://board-asset-picked", (event: CustomEvent) => w.picked.push(event.detail));
w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
  if (command.startsWith("canvas_frequent_assets")) {
    w.calls.push({ command, args });
    if (w.failFrequentCommand === command) throw "模拟常用素材操作失败";
    if (command === "canvas_frequent_assets_pin" && args.assetIds.includes(w.holdPinAssetId)) {
      w.holdPinAssetId = null;
      await new Promise<void>(resolve => { w.releaseHeldPin = () => { delete w.releaseHeldPin; resolve(); }; });
    }
    if (command === "canvas_frequent_assets_pin" && args.assetIds.includes(w.failPinAssetId)) throw "模拟固定素材失败";
    if (command === "canvas_frequent_assets_refresh") preferences.excluded = [];
    if (command === "canvas_frequent_assets_set_threshold") {
      if (!Number.isSafeInteger(args.threshold) || args.threshold < 0) throw "引用次数阈值必须是非负整数";
      preferences.threshold = args.threshold;
    }
    if (command === "canvas_frequent_assets_pin") {
      for (const id of args.assetIds) {
        if (assets.some((asset: any) => asset.id === id) && !preferences.pinned.includes(id)) preferences.pinned.push(id);
      }
    }
    if (command === "canvas_frequent_assets_remove") {
      if (args.row === "pinned") preferences.pinned = preferences.pinned.filter(id => id !== args.assetId);
      else if (!preferences.excluded.includes(args.assetId)) preferences.excluded.push(args.assetId);
    }
    persist();
    return structuredClone(result(args.projectId));
  }
  if (command === "project_canvas_get") return withHiddenNode(await baseInvoke(command, args));
  if (command === "material_catalog") return { tags: [], collections: [], prompts: [], tag_asset_ids: {} };
  if (command === "material_catalog_assets" || command === "list_assets") return visible(args.projectId);
  if (command === "get_assets_by_ids") return assets.filter((asset: any) => args.assetIds.includes(asset.id));
  if (command === "list_library_view") return { assets: visible(args.projectId), total: visible(args.projectId).length, memberships: [] };
  if (command === "count_assets") return visible(args.projectId).length;
  if (command === "external_files_media") { w.calls.push({ command, args }); return args.path; }
  if (command === "external_files_preview") return args.path;
  return baseInvoke(command, args);
};
store.setState({ assets: visible(), projects: [...store.getState().projects, { ...store.getState().projects[0], id: "q", name: "其他合成项目" }] });
