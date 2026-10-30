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
};

export const CanvasImage = memo(function CanvasImage({ path, thumbPath, sourceWidth, sourceHeight, onError, ...props }: Props) {
  const { ref, visible, width, height } = useMediaVisibility<HTMLImageElement>();
  const zoom = useContext(MediaZoom);
  const fallback = canvasAssetMediaPath({ storePath: path ?? null, thumbPath: thumbPath ?? null });
  const size = path ? canvasImagePreviewSize(path, Math.max(width, height) * zoom,
    Math.max(sourceWidth ?? 0, sourceHeight ?? 0)) : null;
  const [loaded, setLoaded] = useState<{ path: string; size: number; preview: string }>();
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    if (!visible || !path || size === null || width <= 0 || height <= 0) return;
    let current = true;
    const request = requestCanvasImagePreview(path, size);
    void request.promise.then(preview => { if (current && preview) setLoaded({ path, size, preview }); });
    return () => { current = false; request.release(); };
  }, [visible, path, size, width > 0, height > 0]);
  // Intrinsic dimensions remain available while a resource is offscreen or queued.
  const placeholder = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${sourceWidth || 160}" height="${sourceHeight || 100}"/>`)}`;
  const preview = loaded && loaded.path === path ? loaded.preview : null;
  const selected = visible ? size === null ? fallback : preview : null;
  const source = selected && failed === selected ? fallback : selected;
  return <img {...props} ref={ref} decoding="async" src={source ? /^(data:|blob:|https?:)/i.test(source) ? source : convertFileSrc(source) : placeholder}
    data-canvas-media-loaded={!!source} onError={event => {
      if (source && source !== fallback) setFailed(source);
      else onError?.(event);
    }} />;
});
