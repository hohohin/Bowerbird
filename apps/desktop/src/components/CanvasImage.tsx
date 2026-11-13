import { createContext, memo, useContext, useEffect, useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { canvasAssetMediaPath } from "../lib/creativeCanvas";
import { canvasImagePreviewSize, requestCanvasImagePreview } from "../lib/canvasImagePreview";
import { useMediaVisibility } from "../lib/useMediaVisibility";

const MediaZoom = createContext(1);
export function CanvasMediaProvider({ zoom, children }: { zoom: number; children: ReactNode }) {
  const [settledZoom, setSettledZoom] = useState(zoom);
  const [pixelRatio, setPixelRatio] = useState(() => window.devicePixelRatio);
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${pixelRatio}dppx)`);
    const update = () => setPixelRatio(window.devicePixelRatio);
    query.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => { query.removeEventListener("change", update); window.removeEventListener("resize", update); };
  }, [pixelRatio]);
  useEffect(() => {
    const timer = setTimeout(() => setSettledZoom(zoom), 150);
    return () => clearTimeout(timer);
  }, [zoom]);
  return <MediaZoom.Provider value={settledZoom * pixelRatio}>{children}</MediaZoom.Provider>;
}

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  path?: string | null; thumbPath?: string | null; sourceWidth?: number | null; sourceHeight?: number | null;
  progressiveThumbnail?: boolean;
};

type Preview = { path: string; preview: string; version: string };
// Only mounted, visible images lend a decoded preview while a thumbnail awaits its own file check.
const visiblePreviews = new Map<string, Set<Preview>>();

export const CanvasImage = memo(function CanvasImage({ path, thumbPath, sourceWidth, sourceHeight, progressiveThumbnail, onError, ...props }: Props) {
  const { ref, visible, width, height } = useMediaVisibility<HTMLImageElement>();
  const zoom = useContext(MediaZoom);
  const fallback = canvasAssetMediaPath({ storePath: path ?? null, thumbPath: thumbPath ?? null });
  const size = path ? canvasImagePreviewSize(path, Math.max(width, height) * zoom,
    Math.max(sourceWidth ?? 0, sourceHeight ?? 0)) : null;
  const version = thumbPath ?? "";
  const [loaded, setLoaded] = useState<Preview>();
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    if (!visible || !path || size === null || width <= 0 || height <= 0) return;
    let current = true;
    const request = requestCanvasImagePreview(path, size, version);
    void request.promise.then(preview => { if (current && preview) setLoaded({ path, preview, version }); });
    return () => { current = false; request.release(); };
  }, [visible, path, size, version, width > 0, height > 0]);
  // Intrinsic dimensions remain available while a resource is offscreen or queued.
  const placeholder = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${sourceWidth || 160}" height="${sourceHeight || 100}"/>`)}`;
  const preview = loaded && loaded.path === path && loaded.version === version ? loaded.preview : null;
  let interim: string | undefined;
  if (progressiveThumbnail && visible && path && size !== null && !preview) {
    const others = visiblePreviews.get(path);
    interim = others && [...others].find(item => item.version === version && item.preview !== failed)?.preview;
    if (!interim && thumbPath && thumbPath !== path && thumbPath !== failed &&
      (/^data:image\/(png|webp|avif)[;,]/i.test(thumbPath) || /\.(png|webp|avif)(?:[?#].*)?$/i.test(thumbPath))) interim = thumbPath;
  }
  const selected = visible ? size === null ? fallback : preview ?? interim : null;
  const source = selected && failed === selected ? fallback : selected;
  useEffect(() => {
    const image = ref.current;
    if (!image || !loaded || source !== loaded.preview || source === path || !preview) return;
    const register = () => {
      const others = visiblePreviews.get(loaded.path) ?? new Set<Preview>();
      others.add(loaded);
      visiblePreviews.set(loaded.path, others);
    };
    if (image.complete && image.naturalWidth) register();
    else image.addEventListener("load", register);
    return () => {
      image.removeEventListener("load", register);
      const others = visiblePreviews.get(loaded.path);
      others?.delete(loaded);
      if (!others?.size) visiblePreviews.delete(loaded.path);
    };
  }, [loaded, source, path, preview, ref]);
  const src = source ? /^(data:|blob:|https?:)/i.test(source) ? source
    : convertFileSrc(source) + (source === path && version ? `?revision=${encodeURIComponent(version)}` : "") : placeholder;
  return <img {...props} ref={ref} decoding="async" src={src}
    data-canvas-media-loaded={!!source} onError={event => {
      if (source && source !== fallback) setFailed(source);
      else onError?.(event);
    }} />;
});
