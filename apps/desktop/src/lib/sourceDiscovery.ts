export interface SourceDiscovery {
  actionLabel: string;
  hint: string;
}

function hostMatches(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** Normalize a typed address without widening the native browser's HTTP(S)-only boundary. */
export function normalizeSourceAddress(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Turns an asset source URL into honest discovery copy. Only Pinterest currently
 * promises a recommendation feed; generic sites are presented as source pages.
 */
export function sourceDiscoveryFor(sourceUrl?: string | null): SourceDiscovery | null {
  if (!sourceUrl) return null;

  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostMatches(hostname, "pinterest.com") || hostMatches(hostname, "pin.it")) {
    return {
      actionLabel: "在 Pinterest 发现更多",
      hint: "打开原 Pin 和 Pinterest 相关推荐；采集新素材可用系统浏览器扩展",
    };
  }

  if (hostMatches(hostname, "xiaohongshu.com") || hostMatches(hostname, "xhslink.com")) {
    return {
      actionLabel: "在小红书继续探索",
      hint: "在应用内打开原笔记和平台相关内容",
    };
  }

  return {
    actionLabel: "在应用内浏览来源",
    hint: `继续查看 ${hostname} 的原始页面`,
  };
}
