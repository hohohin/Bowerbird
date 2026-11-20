import type { MenuItemDescriptor } from "./contextMenuModel";
import type { CanvasNode as ProjectGraphNode } from "./types";

export type CanvasMenuAction = "draft" | "artboard" | "import-package" | "paste" | "copy"
  | "encapsulate" | "save-template" | "export-package" | "reuse" | "remove-section"
  | "ungroup-folder" | "remove-nodes" | "delete-session";

type CanvasMenuIcon = "pen" | "scan" | "copy" | "frame" | "trash" | "ungroup" | "delete-menu";
type CanvasMenuSlot = "asset-transfers" | "selection-actions" | "merge-group" | "dissolve-group" | "section-colors";
type CanvasMenuItem = MenuItemDescriptor<CanvasMenuAction, CanvasMenuIcon, CanvasMenuSlot>;

export type CanvasMenuSection = { name: string; kind: "section" | "artboard" | "container" };
export interface CanvasMenuSnapshot {
  blank: boolean;
  nodeCount: number;
  cardKind: ProjectGraphNode["kind"] | null;
  hasFolder: boolean;
  section?: CanvasMenuSection;
  assetCount: number;
  imageCount: number;
  hasDissolvableGroup: boolean;
  interactive: boolean;
  canSaveTemplate: boolean;
  canExportWorkflow: boolean;
  selectionLocked: boolean;
  sessionRunning: boolean;
}

const REMOVE_SECTION = { section: "移除分区", artboard: "移除画板", container: "解封容器" } as const;

export function buildCanvasContextMenu(snapshot: CanvasMenuSnapshot): { label: string; items: CanvasMenuItem[] } {
  const { blank, nodeCount, cardKind, section, interactive } = snapshot;
  const items: CanvasMenuItem[] = [];
  const selected: CanvasMenuItem[] = [];
  const removeSection: CanvasMenuItem | undefined = section && {
    kind: "action", id: "remove-section", label: `${REMOVE_SECTION[section.kind]}「${section.name}」`,
    icon: "trash", disabled: !interactive, danger: true, title: "移除分区框，保留其中的卡片",
  };
  if (blank) {
    items.push(
      { kind: "action", id: "draft", label: "新建草稿", icon: "pen" },
      { kind: "action", id: "artboard", label: "新建画板", icon: "scan" },
    );
  }
  items.push(
    { kind: "action", id: "import-package", label: "导入工作流数据包", icon: "copy", disabled: !interactive },
    { kind: "action", id: "paste", label: "粘贴卡片", icon: "copy", disabled: !interactive },
  );

  if (nodeCount) selected.push({ kind: "action", id: "copy", label: "复制所选卡片", icon: "copy" });
  if (snapshot.assetCount) selected.push({ kind: "slot", id: "asset-transfers" });
  if (nodeCount) selected.push({ kind: "action", id: "encapsulate", label: "封装为容器", icon: "frame", disabled: !interactive });
  if (snapshot.canSaveTemplate) selected.push({ kind: "action", id: "save-template", label: "存为模板", icon: "copy" });
  if (snapshot.canExportWorkflow) selected.push({ kind: "action", id: "export-package", label: "导出工作流数据包", icon: "copy" });
  if (nodeCount || snapshot.imageCount) selected.push({ kind: "slot", id: "selection-actions" });
  if (nodeCount > 1 && snapshot.assetCount > 1) selected.push({ kind: "slot", id: "merge-group" });
  if (nodeCount === 1 && snapshot.hasDissolvableGroup) selected.push({ kind: "slot", id: "dissolve-group" });
  if (nodeCount === 1 && cardKind) selected.push({ kind: "action", id: "reuse", label: "复用提示词", icon: "copy" });
  if (section?.kind === "section") selected.push({ kind: "slot", id: "section-colors" });

  const deletion: CanvasMenuItem[] = [];
  if (!blank && removeSection) deletion.push(removeSection);
  if (nodeCount === 1 && snapshot.hasFolder) {
    deletion.push({ kind: "action", id: "ungroup-folder", label: "解散素材组", icon: "ungroup" });
  }
  if (nodeCount) {
    deletion.push({
      kind: "action", id: "remove-nodes", label: nodeCount > 1 ? `从画布移出所选 ${nodeCount} 项` : "从画布移出",
      icon: "trash", disabled: !interactive || snapshot.selectionLocked, danger: true,
    });
  }
  if (nodeCount === 1 && cardKind === "prompt") {
    deletion.push({
      kind: "action", id: "delete-session", label: "删除会话", icon: "trash", danger: true, disabled: snapshot.sessionRunning,
      title: snapshot.sessionRunning ? "生成中，请结束后再删除会话" : "删除会话记录及指令卡片，保留已生成图片",
    });
  }
  if (deletion.length) {
    selected.push({ kind: "divider", id: "delete-divider" }, { kind: "submenu", id: "delete-menu", label: "删除", icon: "delete-menu", items: deletion });
  }
  if (blank) {
    if (removeSection) items.push({ kind: "submenu", id: "remove-section-menu", label: "删除", icon: "delete-menu", items: [removeSection] });
    if (nodeCount) items.push({ kind: "submenu", id: "selection", label: `所选 ${nodeCount} 项`, icon: "frame", items: selected });
  } else {
    items.push(...selected);
  }
  const label = cardKind === "agent_group" ? "Agent 执行组菜单" : cardKind ? "生成指令菜单" : "画板节点菜单";
  return { label, items };
}
