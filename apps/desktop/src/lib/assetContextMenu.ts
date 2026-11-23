import { isAudioAsset } from "./audioMedia.ts";
import { isTextAsset } from "./textMedia.ts";
import { isVideoAsset } from "./videoGeneration.ts";
import { userErrorMessage } from "./userError.ts";
import type { MenuItemDescriptor } from "./contextMenuModel";
import type { Asset } from "./types";

const ANNOTATABLE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];
const CANVAS_IMAGE_EXTS = [...ANNOTATABLE_EXTS, "avif", "svg", "ico", "tif", "tiff"];

export type AssetDescribeEngine = "bowerbird-cloud" | "codex";
export type AssetMenuAction =
  | "move-incomplete" | "add-to-chat" | "open-detail" | "open-transcript" | "edit" | "pinterest" | "select" | "rename"
  | "describe-cloud" | "describe-codex" | "dimensions" | "artboard" | "reuse" | "layers" | "history"
  | "assign" | "project-picker" | "reveal" | "open-system" | "copy-image" | "copy-path" | "references"
  | "show-in-library" | "hide-in-library" | "remove-references" | "remove-from-canvas" | "ungroup"
  | "pin-generation-card" | "continue-image-generation" | "create-image-generation-card"
  | "remove-from-project" | "delete-originals" | "delete-generation" | "remove-canvas-item-from-project"
  | "delete-canvas-item" | "remove-canvas-group" | "remove-canvas-group-from-project" | "delete-canvas-group";

type AssetMenuIcon = "edit" | "pin" | "folder-plus" | "folder-tree" | "trash" | "ungroup" | "layers"
  | "status-unavailable" | "status-ready" | "scan-search" | "scan" | "board" | "clipboard" | "message" | "file-text";
type AssetMenuSlot = "canvas-selection" | "generation-group" | "merge-generation-group" | "transfers";
type AssetMenuItem = MenuItemDescriptor<AssetMenuAction, AssetMenuIcon, AssetMenuSlot>;
type AssetActionOptions = Omit<Extract<AssetMenuItem, { kind: "action" }>, "kind" | "id" | "label">;

type MenuAsset = Pick<Asset, "store_path" | "ext" | "source" | "generation_session_id" | "library_hidden">;

export interface AssetMenuSnapshot {
  mode: "incomplete" | "multi" | "single";
  asset?: MenuAsset;
  targets: readonly (MenuAsset | undefined)[];
  selectedCount: number;
  busy: boolean;
  manage: boolean;
  embedded: boolean;
  hasDetail: boolean;
  canSearchPinterest: boolean;
  hasProject: boolean;
  hasMembershipProject: boolean;
  canAddToProject: boolean;
  libraryProject: boolean;
  canvasLibraryStatus: "checking" | "available" | "unavailable" | "failed";
  generationCount: number;
  generationCheck?: "checking" | "unavailable" | "failed";
  canvasImagesPending?: string;
  hasGenerationGroup: boolean;
  canvas?: { nodeCount: number; canRemove: boolean; itemTarget: boolean; groupCount?: number; canUngroup: boolean;
    generationActions?: { pin: boolean; revise: boolean; create: boolean } };
  file?: { local: boolean; entries?: { available: boolean; canRemoveReferences: boolean } };
  describe: { queued: boolean; cloudUsable: boolean; cloudAvailable: boolean; loggedIn: boolean;
    codexUsable: boolean; canUseByo: boolean; codexReason?: string | null };
}

type AssetMenuSection = { heading: string; items: AssetMenuItem[] };

export function buildAssetContextMenu(s: AssetMenuSnapshot): {
  label: string;
  columns: AssetMenuSection[][];
} {
  if (s.mode === "incomplete") return {
    label: "所选素材的操作",
    columns: [[{ heading: "部分所选条目已不存在", items: [{ kind: "action", id: "move-incomplete", label: "移动到文件夹" }] }]],
  };

  const { asset, canvas, file, busy, describe } = s;
  const multi = s.mode === "multi";
  const external = asset?.source === "external";
  const storePath = asset?.store_path;
  const ext = (asset?.ext ?? "").toLowerCase();
  const annotatable = !!storePath && ANNOTATABLE_EXTS.includes(ext);
  const canvasImage = !!storePath && CANVAS_IMAGE_EXTS.includes(ext);
  const audio = !!asset && isAudioAsset(asset);
  const text = !!asset && isTextAsset(asset);
  const video = isVideoAsset(asset);
  const allImages = s.targets.length > 0 && s.targets.every(target =>
    !!target?.store_path && !isVideoAsset(target) && !isAudioAsset(target) && !isTextAsset(target));
  const generated = !audio && !text && !!asset?.generation_session_id;
  const action = (id: AssetMenuAction, label: string, options: AssetActionOptions = {}): AssetMenuItem =>
    ({ kind: "action", id, label, disabled: busy, ...options });
  const pinterest = action("pinterest", "Pinterest 以图搜图");
  const assign = action("assign", "添加到文件夹", { icon: "folder-plus" });
  const transfers: AssetMenuItem = { kind: "slot", id: "transfers" };
  const canvasSelection: AssetMenuItem = { kind: "slot", id: "canvas-selection" };
  const divider: AssetMenuItem = { kind: "divider", id: "delete-divider" };

  const cloudReason = describe.cloudUsable ? null : !describe.cloudAvailable ? "当前版本未配置 Bowerbird Cloud"
    : !describe.loggedIn ? "请先登录 Bowerbird 账号" : "积分不足";
  const codexReason = describe.codexUsable ? null : !describe.canUseByo ? "升级 Pro 解锁本机 codex"
    : describe.codexReason || "codex 不可用";
  function engine(id: "describe-cloud" | "describe-codex", label: string, reason: string | null): AssetMenuItem {
    const disabledReason = reason ? userErrorMessage(reason, "此方式暂不可用，请在设置中重新登录。") : undefined;
    return action(id, label, { icon: reason ? "status-unavailable" : "status-ready", disabledReason,
      title: `用 ${label} 反推`, ariaLabel: disabledReason ? `${label} ${disabledReason}` : undefined });
  }
  const describeMenu: AssetMenuItem = {
    kind: "submenu", id: "describe", label: multi ? "批量反推" : "反推提示词", menuLabel: "选择反推引擎", icon: "scan-search",
    disabled: busy || !!s.canvasImagesPending || (!multi && describe.queued),
    title: s.canvasImagesPending ?? (!multi && describe.queued ? "这张图片正在反推或已排队" : undefined),
    items: [engine("describe-cloud", "Bowerbird Cloud", cloudReason), engine("describe-codex", "本机 codex", codexReason)],
  };

  const deletion: AssetMenuItem[] = [divider];
  if (canvas) {
    if (canvas.canRemove) deletion.push(action("remove-from-canvas", multi ? `从画布移出所选 ${s.selectedCount} 项` : "移出画布",
      { icon: "trash", title: "保留素材原文件" }));
    if (canvas.canUngroup && !multi) deletion.push(action("ungroup", "解散素材组", { icon: "ungroup", disabled: false }));
    if (canvas.itemTarget) deletion.push({
      kind: "submenu", id: "canvas-item", label: multi ? "当前项的项目与原文件" : "项目与原文件", icon: "trash", disabled: busy,
      items: [
        action("remove-canvas-item-from-project", "移出项目", { disabled: !s.hasMembershipProject, title: "移除后，进入全局素材" }),
        action("delete-canvas-item", "删除原文件…", { disabled: false, danger: true, title: "将文件放入回收箱，应用内不可见" }),
      ],
    });
    if (canvas.groupCount !== undefined) deletion.push({
      kind: "submenu", id: "canvas-group", label: `整组操作 · ${canvas.groupCount} 项`, icon: "layers", disabled: busy,
      items: [
        action("remove-canvas-group", "将整组移出画布", { disabled: false, title: "素材仍能在项目素材库找到" }),
        action("remove-canvas-group-from-project", "移出项目", { disabled: !s.hasMembershipProject, title: "移除后，进入全局素材" }),
        action("delete-canvas-group", "删除原文件…", { disabled: false, danger: true, title: "将文件放入回收箱，应用内不可见" }),
      ],
    });
  } else {
    const items: AssetMenuItem[] = [];
    if (file?.entries?.canRemoveReferences) items.push(action("remove-references", s.selectedCount > 1 ? "删除所选分身" : "删除此分身", { disabled: false }));
    if (!multi && s.libraryProject && canvasImage && !asset?.library_hidden) items.push(action("hide-in-library", "从库中删除 · 在画布保留", {
      disabled: s.canvasLibraryStatus !== "available",
      title: {
        checking: "正在检查画布状态…",
        available: "从中央和各项目素材库列表移除，保留所有画布中的图片及原文件",
        unavailable: "请先将图片拖到当前画布",
        failed: "无法检查画布状态，请重新打开菜单",
      }[s.canvasLibraryStatus],
    }));
    if (s.hasMembershipProject && s.targets.length) items.push(action("remove-from-project", "移出当前项目",
      { disabled: false, title: "仅移出当前项目 · 原文件保留" }));
    if (s.targets.length) items.push(action("delete-originals", "删除原文件…", { disabled: false, danger: true }));
    if (!multi && (s.generationCount > 1 || s.generationCheck)) {
      const title = s.generationCheck ? {
        checking: "正在检查生成组…", unavailable: "当前素材没有其他组图", failed: "无法检查生成组，请重新打开菜单",
      }[s.generationCheck] : "将这组生成图的原文件放入回收站";
      items.push(action("delete-generation", s.generationCount > 1 ? `删除整组原文件 · ${s.generationCount} 张` : "删除整组原文件",
        { disabled: !!s.generationCheck, danger: true, title }));
    }
    deletion.push({ kind: "submenu", id: "delete", label: "删除", icon: "trash", disabled: busy, items });
  }

  if (multi) {
    const items: AssetMenuItem[] = [];
    if (canvas) items.push(canvasSelection);
    if ((allImages || s.canvasImagesPending) && s.targets.length > 1) items.push({ kind: "slot", id: "merge-generation-group" });
    if (s.canSearchPinterest) items.push(pinterest);
    if (s.targets.length) items.push(assign);
    if (!file?.local) items.push(transfers);
    if (!s.hasProject && s.canAddToProject) items.push(action("project-picker", "加入项目", { icon: "folder-tree" }));
    if (allImages || s.canvasImagesPending) items.push({ kind: "divider", id: "describe-divider" }, describeMenu);
    const heading = `已选 ${s.selectedCount} 项`;
    return { label: `${heading}素材的操作`, columns: [[{ heading, items: [...items, ...deletion] }]] };
  }

  const common: AssetMenuItem[] = [];
  if (canvas?.generationActions?.pin) common.push(action("pin-generation-card", "固定生成卡", { icon: "pin" }));
  if (canvas?.generationActions?.revise) common.push(action("continue-image-generation", "继续修改", { icon: "message" }));
  if (canvas?.generationActions?.create) common.push(action("create-image-generation-card", "基于此图新建生成卡", { icon: "board" }));
  if (canvas) common.push(canvasSelection);
  if (s.hasGenerationGroup) common.push({ kind: "slot", id: "generation-group" });
  if (!canvas && !audio && !text && !s.manage && s.hasDetail) common.push(action("add-to-chat", "添加到对话框"));
  if (video) common.push(action("open-transcript", "转录文稿", { icon: "file-text", disabled: busy || !storePath || file?.entries?.available === false }));
  else if (asset) common.push(action("open-detail", text ? "打开文本编辑器" : audio ? "打开音频详情" : "打开图片详情"));
  if (annotatable) common.push(action("edit", "编辑", { icon: "edit" }));
  if (s.canSearchPinterest) common.push(pinterest);
  if (!canvas && (!s.embedded || file)) common.push(action("select", !file && s.manage ? "选择/取消选择" : "选择"));
  if (storePath) common.push(action("rename", "重命名", {
    disabled: busy || file?.entries?.available === false,
    title: file?.entries ? "重命名当前文件或分身" : file?.local ? "重命名本机文件" : external ? "修改引用名称，原文件名保留" : "重命名（同步改磁盘文件名）",
  }));

  const creation: AssetMenuItem[] = [];
  if (allImages) creation.push(describeMenu, action("dimensions", "维度", { icon: "scan" }));
  if (canvas?.nodeCount && canvasImage) creation.push(action("artboard", "以此图新建画板", { icon: "board" }));
  if (generated) creation.push(action("reuse", "复用生成提示词", { icon: "clipboard", tour: "ctx-reuse-gen" }));
  if (annotatable) creation.push(action("layers", "分层编辑", { icon: "layers" }));
  if (generated) creation.push(action("history", "回看所属创作", { icon: "message" }));

  const files: AssetMenuItem[] = [assign];
  if (!file?.local) files.push(transfers);
  if (storePath) {
    files.push(action("reveal", "打开所在文件夹"), action("open-system", "用系统程序打开"));
    if (annotatable) files.push(action("copy-image", "复制图片"));
    files.push(action("copy-path", "复制文件路径"));
  }
  if (external) files.push(action("references", "管理外部引用 · 原文件保留"));
  if (canvas && asset?.library_hidden) files.push(action("show-in-library", "加入素材库"));

  const left: AssetMenuSection[] = [{ heading: "常用", items: common }];
  if (creation.length) left.push({ heading: allImages || generated ? "再创作" : "", items: creation });
  return { label: "素材操作", columns: [left, [{ heading: "文件", items: [...files, ...deletion] }]] };
}
