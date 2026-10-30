import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { isVideoPath } from "./videoGeneration";

// Shared across cards and surfaces. Cool down failures without caching them forever.
const RETRY_AFTER_MS = 10_000;
type PosterRequest = { promise: Promise<string | null>; poster?: string | null; retryAt: number; consumers: Set<symbol> };
const requests = new Map<string, PosterRequest>();
let queue: Promise<unknown> = Promise.resolve();
function requestPoster(path: string, consumer: symbol) {
  let request = requests.get(path);
  if (request?.poster === null && Date.now() >= request.retryAt) request = undefined;
  if (!request) {
    const next: PosterRequest = { promise: Promise.resolve(null), retryAt: 0, consumers: new Set() };
    next.promise = queue.then(async () => {
      // Scrolling away can abandon a queued cover before the decoder is free.
      // An extraction already started is allowed to finish and warm the cache.
      if (!next.consumers.size) {
        if (requests.get(path) === next) requests.delete(path);
        return null;
      }
      const result = await api.videoPoster(path).catch(() => null);
      const value = typeof result === "string" && result ? result : null;
      next.poster = value;
      next.retryAt = value ? 0 : Date.now() + RETRY_AFTER_MS;
      return value;
    });
    request = next;
    requests.set(path, request);
    queue = request.promise;
  }
  request.consumers.add(consumer);
  return request;
}

/** An image load failure invalidates only that completed cover, never an in-flight repair. */
export function invalidateVideoPoster(path: string, poster: string) {
  if (requests.get(path)?.poster === poster) requests.delete(path);
}

export function useVideoPoster(path?: string | null, existing?: string | null, repairing = false, enabled = true) {
  const [loaded, setLoaded] = useState<{ path: string; poster: string | null; repairing: boolean }>();
  const poster = existing && !isVideoPath(existing) ? existing : null;
  const attempt = useRef<{ path: typeof path; poster: typeof poster; repairing: boolean; retried: boolean; request?: PosterRequest }>();
  useEffect(() => {
    if (!attempt.current || attempt.current.path !== path || attempt.current.poster !== poster || attempt.current.repairing !== repairing) {
      attempt.current = { path, poster, repairing, retried: false };
    }
    if (!enabled || !path || !isVideoPath(path) || poster) return;
    const activeAttempt = attempt.current;
    const consumer = Symbol(path);
    let current = true;
    let subscribed: PosterRequest | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retry = () => {
      if (activeAttempt.retried) return;
      timer = setTimeout(() => {
        activeAttempt.retried = true;
        void load();
      }, Math.max(0, (activeAttempt.request?.retryAt ?? 0) - Date.now()));
    };
    const load = async () => {
      subscribed?.consumers.delete(consumer);
      const request = requestPoster(path, consumer);
      subscribed = activeAttempt.request = request;
      const value = await request.promise;
      if (!current) return;
      setLoaded({ path, poster: value, repairing });
      // Visibility changes pause the timer without granting another retry.
      if (!value) retry();
    };
    if (activeAttempt.request?.poster === null) retry();
    else void load();
    return () => { current = false; clearTimeout(timer); subscribed?.consumers.delete(consumer); };
  }, [path, poster, repairing, enabled]);
  return poster ?? (loaded && loaded.path === path && loaded.repairing === repairing ? loaded.poster : null);
}
