import { useEffect, useRef } from "react";
import { layerSurface, type DraftRect, type DraftWorkingDocument } from "../lib/draftDocument";

/** View-only crop preview, including retained pixels outside the current document. */
export function DraftCropPreview({ doc, rect, fit, scale, epoch }: {
  doc: DraftWorkingDocument; rect: DraftRect; fit: number; scale: number; epoch: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const canvas = ref.current;
      if (!canvas) return;
      // Bound preview memory independently of layer buffers. Only confirmation expands layers.
      const resolution = Math.min(1, scale * (window.devicePixelRatio || 1), 2048 / Math.max(rect.width, rect.height));
      canvas.width = Math.max(1, Math.ceil(rect.width * resolution));
      canvas.height = Math.max(1, Math.ceil(rect.height * resolution));
      const context = canvas.getContext("2d")!;
      context.setTransform(resolution, 0, 0, resolution, -rect.x * resolution, -rect.y * resolution);
      for (const layer of doc.layers) {
        if (!layer.visible || !layer.opacity) continue;
        context.globalAlpha = layer.opacity;
        const extendsBackground = layer.id === doc.backgroundLayerId && layer.kind === "raster"
          && layer.x <= 0 && layer.y <= 0 && layer.width === layer.canvas.width && layer.height === layer.canvas.height
          && layer.x + layer.width >= doc.width && layer.y + layer.height >= doc.height;
        if (extendsBackground) {
          context.save(); context.beginPath();
          context.rect(rect.x, rect.y, rect.width, rect.height);
          context.rect(layer.x, layer.y, layer.width, layer.height);
          context.clip("evenodd"); context.fillStyle = "#fff";
          context.fillRect(rect.x, rect.y, rect.width, rect.height); context.restore();
        }
        context.drawImage(layerSurface(layer), layer.x, layer.y, layer.width, layer.height);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [doc, rect, scale, epoch]);
  return <canvas ref={ref} data-draft-crop-preview aria-hidden="true" className="draft-crop-preview"
    style={{ left: rect.x * fit, top: rect.y * fit, width: rect.width * fit, height: rect.height * fit }} />;
}
