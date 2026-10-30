import { api } from "./api";

/** Raster formats whose existing JPEG thumbnails cannot preserve transparency. */
export function canvasImagePreviewSize(path: string, displaySize: number, originalSize = 0) {
  if (/^(data:|blob:|https?:)/i.test(path) || !/\.(png|webp|avif|bmp|ico)$/i.test(path)) return null;
  if (displaySize > 2048) return null;
  const size = displaySize <= 512 ? 512 : displaySize <= 1024 ? 1024 : 2048;
  return originalSize > 0 && originalSize <= size ? null : size;
}

type PreviewRequest = { active: number; promise: Promise<string | null> };
const requests = new Map<string, PreviewRequest>();
let queue: Promise<unknown> = Promise.resolve();

/** Share in-flight work only; native cache checks the file fingerprint on every visit. */
export function requestCanvasImagePreview(path: string, maxSize: number) {
  const key = `${maxSize}:${path}`;
  let request = requests.get(key);
  if (!request) {
    const next: PreviewRequest = { active: 0, promise: Promise.resolve(null) };
    next.promise = queue.then(async () => {
      if (!next.active) return null;
      try {
        const preview = await api.canvasImagePreview(path, maxSize);
        return typeof preview === "string" && preview ? preview : path;
      } catch { return path; }
    }).finally(() => { if (requests.get(key) === next) requests.delete(key); });
    requests.set(key, next);
    queue = next.promise;
    request = next;
  }
  request.active += 1;
  return { promise: request.promise, release: () => { request.active -= 1; } };
}
