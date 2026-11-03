export const EXPLORER_MIME = "application/x-bowerbird-explorer";
export const DEFAULT_EXPLORER_URL = "https://www.xiaohongshu.com/explore";
export const EXPLORER_SITES = [
  { name: "Pinterest", url: "https://www.pinterest.com/" },
  { name: "花瓣", url: "https://huaban.com/" },
  { name: "小红书", url: "https://www.xiaohongshu.com/explore" },
  { name: "即梦", url: "https://jimeng.jianying.com/ai-tool/home" },
] as const;
export interface ExplorerImage { version: 1; imageUrl: string; pageUrl: string; dragId?: string; mediaKind?: "image" | "video"; posterUrl?: string; blocked?: "protected_video" }
export function parseExplorerImage(data: Pick<DataTransfer, "getData">): ExplorerImage | null {
  const fallback = data.getData("text/plain");
  const text = data.getData(EXPLORER_MIME) || (fallback.startsWith("bowerbird-explorer:") ? fallback.slice(19) : "");
  if (!text || text.length > 16384) return null;
  try {
    const value = JSON.parse(text);
    if (value.version !== 1 || typeof value.imageUrl !== "string" || typeof value.pageUrl !== "string") return null;
    if (value.mediaKind !== undefined && value.mediaKind !== "image" && value.mediaKind !== "video") return null;
    if (value.blocked !== undefined && (value.mediaKind !== "video" || value.blocked !== "protected_video")) return null;
    for (const [index, raw] of [value.imageUrl, value.pageUrl].entries()) {
      const url = new URL(raw);
      const blob = index === 0 && value.mediaKind === "video" && url.protocol === "blob:";
      const source = blob ? new URL(url.pathname) : url;
      if (!/^https?:$/.test(source.protocol) || source.username || source.password) return null;
    }
    if (value.posterUrl !== undefined) {
      if (value.mediaKind !== "video" || typeof value.posterUrl !== "string") return null;
      const poster = new URL(value.posterUrl);
      if (!/^https?:$/.test(poster.protocol) || poster.username || poster.password) return null;
    }
    if (value.dragId !== undefined && (typeof value.dragId !== "string" || !/^[a-f0-9]{32}$/.test(value.dragId))) return null;
    return { version: 1, imageUrl: value.imageUrl, pageUrl: value.pageUrl, ...(value.dragId ? { dragId: value.dragId } : {}),
      ...(value.mediaKind ? { mediaKind: value.mediaKind } : {}), ...(value.posterUrl ? { posterUrl: value.posterUrl } : {}), ...(value.blocked ? { blocked: value.blocked } : {}) };
  } catch { return null; }
}

// Native WebView operations must finish in order, including cleanup after a slow open.
let browserOperations = Promise.resolve();
export function queueBrowserOperation(operation: () => Promise<void>): Promise<void> {
  const next = browserOperations.then(operation);
  browserOperations = next.catch(() => {});
  return next;
}
