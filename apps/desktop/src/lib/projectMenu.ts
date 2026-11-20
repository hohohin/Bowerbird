import type { MenuItemDescriptor } from "./contextMenuModel";
import type { Project } from "./types";

export type ProjectMenuAction = "rename" | "refresh" | "delete";

export function buildProjectMenu(kind: Project["kind"] | undefined, refreshing: boolean, deleting: boolean): MenuItemDescriptor<ProjectMenuAction, ProjectMenuAction>[] {
  const disabled = refreshing || deleting;
  const entries: MenuItemDescriptor<ProjectMenuAction, ProjectMenuAction>[] = [
    { kind: "action", id: "rename", label: "重命名", icon: "rename", disabled: disabled || !kind },
  ];
  if (kind !== "builtin" && kind !== "blank") {
    entries.push({
      kind: "action", id: "refresh", label: refreshing ? "更新中…" : "更新项目文件",
      icon: "refresh", disabled, title: "更新文件夹中的图片素材",
    });
  }
  entries.push(
    { kind: "divider", id: "delete-divider" },
    { kind: "action", id: "delete", label: "删除项目 · 素材保留", icon: "delete", disabled, title: "删除项目，默认保留素材", danger: true },
  );
  return entries;
}
