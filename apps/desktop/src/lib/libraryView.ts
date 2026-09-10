import type { Asset, Project } from "./types";

export interface ProjectMembership {
  assetId: string;
  projectId: string;
}

export interface LibraryView {
  assets: Asset[];
  memberships: ProjectMembership[];
  total: number;
}

export interface LibraryProjectGroup {
  project: Project;
  assets: Asset[];
}

export function groupLibraryAssets(assets: Asset[], projects: Project[], memberships: ProjectMembership[]) {
  const groups = new Map<string, LibraryProjectGroup>(projects
    .filter((project) => !project.provisional && !project.archived_at)
    .map((project) => [project.id, { project, assets: [] }]));
  const owners = new Map<string, Set<string>>();
  for (const membership of memberships) {
    if (!groups.has(membership.projectId)) continue;
    const ids = owners.get(membership.assetId) ?? new Set<string>();
    ids.add(membership.projectId);
    owners.set(membership.assetId, ids);
  }
  const globalAssets: Asset[] = [];
  for (const asset of assets) {
    const ids = owners.get(asset.id);
    if (!ids?.size) globalAssets.push(asset);
    else for (const id of ids) groups.get(id)!.assets.push(asset);
  }
  return { globalAssets, projectGroups: [...groups.values()].filter((group) => group.assets.length > 0) };
}
