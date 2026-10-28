import { useEffect, useState } from "react";
import { api } from "./api";
import { isVideoPath } from "./videoGeneration";

// Shared across cards and surfaces. Cool down failures without caching them forever.
const RETRY_AFTER_MS = 10_000;
type PosterRequest = { promise: Promise<string | null>; poster?: string | null; retryAt: number };
const requests = new Map<string, PosterRequest>();
let queue: Promise<unknown> = Promise.resolve();
function requestPoster(path: string) {
  let request = requests.get(path);
  if (request?.poster === null && Date.now() >= request.retryAt) request = undefined;
  if (!request) {
    const next: PosterRequest = { promise: Promise.resolve(null), retryAt: 0 };
    next.promise = queue.then(() => api.videoPoster(path)).then(value => typeof value === "string" && value ? value : null).catch(() => null)
      .then(value => {
        next.poster = value;
        next.retryAt = value ? 0 : Date.now() + RETRY_AFTER_MS;
        return value;
      });
    request = next;
    requests.set(path, request);
    queue = request.promise;
  }
  return request;
}

/** An image load failure invalidates only that completed cover, never an in-flight repair. */
export function invalidateVideoPoster(path: string, poster: string) {
  if (requests.get(path)?.poster === poster) requests.delete(path);
}

export function useVideoPoster(path?: string | null, existing?: string | null, repairing = false) {
  const [loaded, setLoaded] = useState<{ path: string; poster: string | null; repairing: boolean }>();
  const poster = existing && !isVideoPath(existing) ? existing : null;
  useEffect(() => {
    if (!path || !isVideoPath(path) || poster) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (retry: boolean) => {
      const request = requestPoster(path);
      const value = await request.promise;
      if (!current) return;
      setLoaded({ path, poster: value, repairing });
      // One automatic retry per mount; remounts share the same cooldown and queue.
      if (!value && retry) timer = setTimeout(() => void load(false), Math.max(0, request.retryAt - Date.now()));
    };
    void load(true);
    return () => { current = false; clearTimeout(timer); };
  }, [path, poster, repairing]);
  return poster ?? (loaded && loaded.path === path && loaded.repairing === repairing ? loaded.poster : null);
}
