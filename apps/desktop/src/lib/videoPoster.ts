import { useEffect, useState } from "react";
import { api } from "./api";
import { isVideoPath } from "./videoGeneration";

// Shared across card remounts and surfaces. Failed decodes are not retried by render loops.
const requests = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();
function requestPoster(path: string) {
  let request = requests.get(path);
  if (!request) {
    request = queue.then(() => api.videoPoster(path)).then(value => typeof value === "string" ? value : null).catch(() => null);
    requests.set(path, request);
    queue = request;
  }
  return request;
}

export function useVideoPoster(path?: string | null, existing?: string | null) {
  const [loaded, setLoaded] = useState<{ path: string; poster: string | null }>();
  const poster = existing && !isVideoPath(existing) ? existing : null;
  useEffect(() => {
    if (!path || !isVideoPath(path) || poster) return;
    let current = true;
    void requestPoster(path).then(value => { if (current) setLoaded({ path, poster: value }); });
    return () => { current = false; };
  }, [path, poster]);
  return poster ?? (loaded?.path === path ? loaded?.poster : null);
}
