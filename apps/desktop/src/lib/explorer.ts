export const EXPLORER_MIME = "application/x-bowerbird-explorer";
export const DEFAULT_EXPLORER_URL = "https://www.xiaohongshu.com/explore";
export const EXPLORER_SITES = [
  { name: "Pinterest", url: "https://www.pinterest.com/" },
  { name: "花瓣", url: "https://huaban.com/" },
  { name: "小红书", url: "https://www.xiaohongshu.com/explore" },
  { name: "即梦", url: "https://jimeng.jianying.com/ai-tool/home" },
] as const;
export interface ExplorerImage { version: 1; imageUrl: string; pageUrl: string }
export function parseExplorerImage(data: Pick<DataTransfer, "getData">): ExplorerImage | null {
  const fallback = data.getData("text/plain");
  const text = data.getData(EXPLORER_MIME) || (fallback.startsWith("bowerbird-explorer:") ? fallback.slice(19) : "");
  if (!text || text.length > 16384) return null;
  try {
    const value = JSON.parse(text);
    if (value.version !== 1 || typeof value.imageUrl !== "string" || typeof value.pageUrl !== "string") return null;
    for (const raw of [value.imageUrl, value.pageUrl]) {
      const url = new URL(raw);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    }
    return { version: 1, imageUrl: value.imageUrl, pageUrl: value.pageUrl };
  } catch { return null; }
}

// Native WebView operations must finish in order, including cleanup after a slow open.
let browserOperations = Promise.resolve();
export function queueBrowserOperation(operation: () => Promise<void>): Promise<void> {
  const next = browserOperations.then(operation);
  browserOperations = next.catch(() => {});
  return next;
}
