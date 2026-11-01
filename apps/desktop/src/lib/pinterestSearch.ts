import { create } from "zustand";
import { api } from "./api";
import type { Asset } from "./types";
import { useStore } from "../store";

export const PINTEREST_SEARCH_URL = "https://www.pinterest.com/";
export const PINTEREST_SEARCH_EVENT = "source-browser://pinterest-search";
export interface PinterestSearchRequest {
  requestId: string;
  assetId: string;
  projectId: string | null;
  routeRevision: number;
}
export interface PinterestSearchStatus {
  requestId: string;
  status: "preparing" | "waiting-login" | "searching" | "submitted" | "error";
  message?: string;
}
export const usePinterestSearch = create<{
  request: PinterestSearchRequest | null;
  progress: PinterestSearchStatus | null;
}>(() => ({ request: null, progress: null }));

export function canSearchPinterest(asset: Asset | null | undefined): boolean {
  return !!asset?.store_path && ["jpg", "jpeg", "png", "webp", "gif", "bmp", "heic", "heif"].includes((asset.ext ?? "").toLowerCase());
}

export function cancelPinterestSearch(requestId = usePinterestSearch.getState().request?.requestId) {
  if (!requestId) return;
  if (usePinterestSearch.getState().request?.requestId === requestId) usePinterestSearch.setState({ request: null, progress: null });
  void api.cancelPinterestImageSearch(requestId).catch(error => console.error("Pinterest search cancellation failed", error));
}

export function requestPinterestSearch(assetId: string) {
  const route = useStore.getState();
  if (route.projectRoutePending) return;
  cancelPinterestSearch();
  const request = { requestId: crypto.randomUUID(), assetId, projectId: route.activeProjectId, routeRevision: route.projectRouteRevision };
  usePinterestSearch.setState({ request, progress: { requestId: request.requestId, status: "preparing" } });
}

export function isPinterestSearchCurrent(request: PinterestSearchRequest): boolean {
  const route = useStore.getState();
  return usePinterestSearch.getState().request?.requestId === request.requestId
    && !route.projectRoutePending && route.activeProjectId === request.projectId && route.projectRouteRevision === request.routeRevision;
}

export function receivePinterestSearchStatus(progress: PinterestSearchStatus) {
  const current = usePinterestSearch.getState();
  if (current.request && current.request.requestId === progress.requestId && isPinterestSearchCurrent(current.request)
    && current.progress?.status !== "submitted" && current.progress?.status !== "error") usePinterestSearch.setState({ progress });
}
