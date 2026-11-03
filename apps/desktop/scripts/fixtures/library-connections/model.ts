// Isolated design fixture. These operations change memory only; no IPC or filesystem access.
export type Media = {
  id: string; name: string; kind: "image" | "video"; src: string;
  width: number; height: number; tags: string[]; available: boolean;
};
export type Folder = { id: string; name: string; parentId: string | null; rootId: string };
export type Entry = { id: string; folderId: string; assetId: string; name: string; reference: boolean };
export type State = {
  folders: Folder[]; assets: Media[]; entries: Entry[];
  roots: Record<string, { path: string; available: boolean }>;
};

const samples = [
  [new URL("../../../../../dev-doc/ui-studies/library-selection-2026-10-26/site/assets/sample-1.jpg", import.meta.url).href, 310, 480],
  [new URL("../../../../../dev-doc/ui-studies/library-selection-2026-10-26/site/assets/sample-2.jpg", import.meta.url).href, 270, 480],
  [new URL("../../../../../dev-doc/ui-studies/library-selection-2026-10-26/site/assets/sample-4.jpg", import.meta.url).href, 320, 480],
  [new URL("../../../../../dev-doc/ui-studies/library-selection-2026-10-26/site/assets/sample-5.jpg", import.meta.url).href, 270, 480],
  [new URL("../../../../../dev-doc/ui-studies/library-selection-2026-10-26/site/assets/sample-4.jpg", import.meta.url).href, 320, 480],
  [new URL("../../../../../dev-doc/ui-studies/library-selection-2026-10-26/site/assets/sample-2.jpg", import.meta.url).href, 270, 480],
] as const;

function media(id: string, name: string, sample: number, tags: string[], kind: Media["kind"] = "image"): Media {
  const [path, width, height] = samples[sample % samples.length];
  return { id, name, src: path, width, height, tags, kind, available: true };
}

export function createState(): State {
  const folders: Folder[] = [
    { id: "brand", name: "品牌素材", parentId: null, rootId: "brand" },
    { id: "products", name: "产品", parentId: "brand", rootId: "brand" },
    { id: "details", name: "细节", parentId: "products", rootId: "brand" },
    { id: "videos", name: "视频", parentId: "brand", rootId: "brand" },
    { id: "inspiration", name: "灵感", parentId: "brand", rootId: "brand" },
    { id: "projects", name: "项目参考", parentId: null, rootId: "projects" },
    { id: "proposal", name: "春季提案", parentId: "projects", rootId: "projects" },
    { id: "drive", name: "移动硬盘", parentId: null, rootId: "drive" },
    { id: "archive", name: "往期影像", parentId: "drive", rootId: "drive" },
  ];
  const groups: [string, Media[]][] = [
    ["brand", [
      media("brand-01", "自然之间.jpg", 0, ["品牌", "海报"]),
      media("brand-02", "花的形状.jpg", 1, ["品牌", "植物"]),
      media("brand-03", "新作发布.jpg", 2, ["品牌", "海报"]),
      media("brand-04", "春日序曲.jpg", 3, ["品牌", "植物"]),
      media("brand-05", "品牌短片.mp4", 0, ["品牌", "影像"], "video"),
    ]],
    ["products", [
      media("product-01", "产品主视觉.jpg", 4, ["产品", "静物"]),
      media("product-02", "包装方案.jpg", 2, ["产品", "包装"]),
      media("product-03", "系列海报.jpg", 0, ["产品", "海报"]),
      media("product-04", "产品场景.jpg", 5, ["产品", "植物"]),
      media("product-05", "限定包装.jpg", 3, ["产品", "包装"]),
    ]],
    ["details", [
      media("detail-01", "材质细节.jpg", 1, ["产品", "细节"]),
      media("detail-02", "局部构图.jpg", 4, ["静物", "细节"]),
    ]],
    ["videos", [
      media("video-01", "新品演示.mp4", 2, ["产品", "影像"], "video"),
      media("video-02", "自然光影.mp4", 5, ["植物", "影像"], "video"),
    ]],
    ["inspiration", [
      media("inspiration-01", "东方留白.jpg", 5, ["植物", "灵感"]),
      media("inspiration-02", "字与图.jpg", 2, ["海报", "灵感"]),
      media("inspiration-03", "色彩研究.jpg", 1, ["品牌", "灵感"]),
      media("inspiration-04", "秋日静物.jpg", 4, ["静物", "灵感"]),
    ]],
    ["archive", [
      { ...media("archive-01", "展览记录.jpg", 3, ["影像"]), available: false },
      { ...media("archive-02", "幕后花絮.mp4", 0, ["影像"], "video"), available: false },
    ]],
  ];
  return {
    folders,
    assets: groups.flatMap(([, assets]) => assets),
    entries: [
      ...groups.flatMap(([folderId, assets]) => assets.map(asset => ({
        id: `entry-${asset.id}`, folderId, assetId: asset.id, name: asset.name, reference: false,
      }))),
      ...["brand-01", "product-01", "video-01"].map(assetId => ({
        id: `reference-${assetId}`, folderId: "proposal", assetId,
        name: groups.flatMap(([, assets]) => assets).find(asset => asset.id === assetId)!.name + ".bowerbird", reference: true,
      })),
    ],
    roots: {
      brand: { path: "D:/设计资料/品牌素材", available: true },
      projects: { path: "D:/项目参考", available: true },
      drive: { path: "E:/移动硬盘", available: false },
    },
  };
}

function copy(state: State): State { return structuredClone(state); }
function nextId(state: State, prefix: string) {
  const ids = new Set([...state.folders, ...state.assets, ...state.entries].map(item => item.id));
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
}
function validName(value: string) {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || name.endsWith(".")) {
    throw new Error("请输入有效名称，不包含路径或特殊字符");
  }
  return name;
}
function writableFolder(state: State, id: string) {
  const folder = state.folders.find(item => item.id === id);
  if (!folder) throw new Error("文件夹已不存在");
  if (!state.roots[folder.rootId]?.available) throw new Error("文件夹暂时不可用，请先重新连接");
  return folder;
}
function entryNameTaken(state: State, folderId: string, name: string, except?: string) {
  return state.entries.some(item => item.id !== except && item.folderId === folderId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
}
function uniqueEntryName(state: State, folderId: string, proposed: string) {
  if (!entryNameTaken(state, folderId, proposed)) return proposed;
  const suffix = proposed.endsWith(".bowerbird") ? ".bowerbird" : "";
  const base = suffix ? proposed.slice(0, -suffix.length) : proposed;
  let number = 2;
  while (entryNameTaken(state, folderId, `${base} (${number})${suffix}`)) number++;
  return `${base} (${number})${suffix}`;
}

/** Descendant IDs exclude the selected folder itself. */
export function descendants(state: State, folderId: string): string[] {
  const result: string[] = [];
  const seen = new Set([folderId]);
  function visit(id: string) {
    for (const child of state.folders.filter(folder => folder.parentId === id)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id); result.push(child.id); visit(child.id);
    }
  }
  visit(folderId);
  return result;
}

/** Display breadcrumb names, including the root and selected folder. */
export function folderPath(state: State, folderId: string): string[] {
  const names: string[] = [], seen = new Set<string>();
  let folder = state.folders.find(item => item.id === folderId);
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id); names.unshift(folder.name);
    folder = state.folders.find(item => item.id === folder!.parentId);
  }
  return names;
}

export function entriesIn(state: State, folderId: string, recursive: boolean): Entry[] {
  const ids = new Set([folderId, ...(recursive ? descendants(state, folderId) : [])]);
  return state.entries.filter(entry => ids.has(entry.folderId));
}

export function addReference(state: State, entryIds: string[], targetId: string): State {
  writableFolder(state, targetId);
  const next = copy(state);
  for (const id of new Set(entryIds)) {
    const original = next.entries.find(entry => entry.id === id);
    if (!original) throw new Error("所选条目已不存在");
    if (next.entries.some(entry => entry.folderId === targetId && entry.assetId === original.assetId)) continue;
    const asset = next.assets.find(asset => asset.id === original.assetId)!;
    next.entries.push({ id: nextId(next, "reference"), folderId: targetId, assetId: asset.id,
      name: uniqueEntryName(next, targetId, `${asset.name}.bowerbird`), reference: true });
  }
  return next;
}

export function renameEntry(state: State, entryId: string, value: string): State {
  const next = copy(state), entry = next.entries.find(item => item.id === entryId);
  if (!entry) throw new Error("条目已不存在");
  writableFolder(next, entry.folderId);
  let name = validName(value);
  if (entry.reference && !name.endsWith(".bowerbird")) name += ".bowerbird";
  if (entryNameTaken(next, entry.folderId, name, entry.id)) throw new Error("文件夹中已有同名条目");
  entry.name = name;
  if (!entry.reference) next.assets.find(asset => asset.id === entry.assetId)!.name = name;
  return next;
}

export function removeEntry(state: State, entryId: string): State {
  const next = copy(state), entry = next.entries.find(item => item.id === entryId);
  if (!entry) return next;
  writableFolder(next, entry.folderId);
  next.entries = next.entries.filter(item => item.id !== entryId);
  if (!entry.reference) next.assets.find(asset => asset.id === entry.assetId)!.available = false;
  return next;
}

export function newFolder(state: State, parentId: string | null, value: string): State {
  const name = validName(value), next = copy(state);
  const parent = parentId ? writableFolder(next, parentId) : null;
  if (next.folders.some(folder => folder.parentId === parentId && folder.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new Error("该位置已有同名文件夹");
  }
  const id = nextId(next, "folder");
  next.folders.push({ id, name, parentId, rootId: parent?.rootId ?? id });
  if (!parent) next.roots[id] = { path: `D:/设计资料/${name}`, available: true };
  return next;
}

export function renameFolder(state: State, folderId: string, value: string): State {
  const name = validName(value), next = copy(state), folder = writableFolder(next, folderId);
  if (next.folders.some(item => item.id !== folderId && item.parentId === folder.parentId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new Error("该位置已有同名文件夹");
  }
  folder.name = name;
  if (!folder.parentId) {
    const root = next.roots[folder.rootId];
    const separator = Math.max(root.path.lastIndexOf("/"), root.path.lastIndexOf("\\"));
    root.path = root.path.slice(0, separator + 1) + name;
  }
  return next;
}

export function moveFolder(state: State, folderId: string, targetParentId: string): State {
  const source = writableFolder(state, folderId), target = writableFolder(state, targetParentId);
  const subtree = new Set([folderId, ...descendants(state, folderId)]);
  if (subtree.has(targetParentId)) throw new Error("文件夹不能移入自身或其子文件夹");
  if (state.folders.some(folder => folder.id !== folderId && folder.parentId === targetParentId
    && folder.name.toLocaleLowerCase() === source.name.toLocaleLowerCase())) {
    throw new Error("目标位置已有同名文件夹");
  }
  const next = copy(state);
  for (const folder of next.folders) {
    if (!subtree.has(folder.id)) continue;
    folder.rootId = target.rootId;
    if (folder.id === folderId) folder.parentId = targetParentId;
  }
  // Moving a connected root inside another root also removes its old top-level connection.
  if (!source.parentId) delete next.roots[source.rootId];
  return next;
}

export function deleteFolder(state: State, folderId: string): State {
  const folder = writableFolder(state, folderId);
  const subtree = new Set([folderId, ...descendants(state, folderId)]);
  const originals = new Set(state.entries.filter(entry => subtree.has(entry.folderId) && !entry.reference).map(entry => entry.assetId));
  const next = copy(state);
  next.folders = next.folders.filter(item => !subtree.has(item.id));
  next.entries = next.entries.filter(entry => !subtree.has(entry.folderId));
  next.assets = next.assets.map(asset => originals.has(asset.id) ? { ...asset, available: false } : asset);
  if (!folder.parentId) delete next.roots[folder.rootId];
  return next;
}

export function disconnectRoot(state: State, rootId: string): State {
  const next = copy(state), ids = new Set(next.folders.filter(folder => folder.rootId === rootId).map(folder => folder.id));
  next.folders = next.folders.filter(folder => !ids.has(folder.id));
  next.entries = next.entries.filter(entry => !ids.has(entry.folderId));
  delete next.roots[rootId];
  // Asset identity and creative information survive disconnection.
  return next;
}

export function moveEntries(state: State, entryIds: string[], targetId: string): State {
  writableFolder(state, targetId);
  const next = copy(state);
  for (const id of new Set(entryIds)) {
    const entry = next.entries.find(item => item.id === id);
    if (!entry) throw new Error("所选条目已不存在");
    writableFolder(next, entry.folderId);
    if (entry.folderId === targetId) continue;
    if (next.entries.some(item => item.id !== id && item.folderId === targetId && item.assetId === entry.assetId)) {
      throw new Error("目标文件夹已包含这个素材");
    }
    if (entryNameTaken(next, targetId, entry.name)) throw new Error("目标文件夹已有同名条目");
    entry.folderId = targetId;
  }
  return next;
}

export function reconnect(state: State, rootId: string): State {
  if (!state.roots[rootId]) throw new Error("连接已不存在");
  const next = copy(state);
  next.roots[rootId].available = true;
  const assets = new Set(next.entries.filter(entry => !entry.reference
    && next.folders.find(folder => folder.id === entry.folderId)?.rootId === rootId).map(entry => entry.assetId));
  next.assets = next.assets.map(asset => assets.has(asset.id) ? { ...asset, available: true } : asset);
  return next;
}

export function connectDemo(state: State): State {
  if (state.roots.travel) return reconnect(state, "travel");
  const next = copy(state);
  next.roots.travel = { path: "C:/Users/Demo/Pictures/旅行采风", available: true };
  next.folders.push(
    { id: "travel", name: "旅行采风", parentId: null, rootId: "travel" },
    { id: "travel-nature", name: "自然", parentId: "travel", rootId: "travel" },
  );
  const assets = [
    media("travel-01", "沿途风景.jpg", 5, ["植物", "灵感"]),
    media("travel-02", "城市切片.jpg", 2, ["海报", "灵感"]),
    media("travel-03", "林间光影.jpg", 1, ["植物"]),
    media("travel-04", "旅途记录.mp4", 0, ["影像"], "video"),
  ];
  for (const [index, asset] of assets.entries()) {
    if (!next.assets.some(item => item.id === asset.id)) next.assets.push(asset);
    next.entries.push({ id: `entry-${asset.id}`, folderId: index < 2 ? "travel" : "travel-nature",
      assetId: asset.id, name: asset.name, reference: false });
  }
  return next;
}
