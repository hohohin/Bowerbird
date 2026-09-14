import { decodeLayerImage, renderLayerDocument, renderTextLayer, type LayerDocument } from "./layerDocument";

/** PSD keeps a pixel preview for each layer as well as editable type metadata. */
export async function exportLayerPsd(document: LayerDocument, fontNames: Record<string, string> = {}): Promise<Uint8Array> {
  const pixels = document.width * document.height + document.layers.reduce((sum, layer) => sum + Math.ceil(layer.width) * Math.ceil(layer.height), 0);
  if (pixels > 64_000_000 || document.layers.some(layer => layer.width > 30000 || layer.height > 30000)) {
    throw new Error("图层尺寸过大，无法安全导出 PSD，请缩小图层后重试");
  }
  const { writePsdUint8Array } = await import("ag-psd");
  const children: import("ag-psd").Layer[] = [];
  // ag-psd serializes children bottom-to-top (Photoshop's DOM reads them reversed).
  for (const layer of document.layers) {
    const left = Math.floor(layer.x), top = Math.floor(layer.y);
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.ceil(layer.x + layer.width) - left;
    canvas.height = Math.ceil(layer.y + layer.height) - top;
    const image = await decodeLayerImage(layer.text ? await renderTextLayer(layer.text) : layer.dataUrl);
    canvas.getContext("2d")!.drawImage(image, layer.x - left, layer.y - top, layer.width, layer.height);
    const text = layer.text;
    children.push({ name: layer.name, left, top, canvas, hidden: !layer.visible, opacity: layer.opacity, blendMode: "normal",
      ...(text ? { text: {
        text: text.content.replace(/\n/g, "\r"),
        transform: [layer.width / text.boxWidth, 0, 0, layer.height / text.boxHeight, layer.x, layer.y],
        shapeType: "box" as const, boxBounds: [0, 0, text.boxWidth, text.boxHeight],
        antiAlias: "smooth" as const,
        style: { font: { name: fontNames[text.fontFamily] ?? text.fontFamily }, fontSize: text.fontSize, fauxBold: text.bold,
          autoLeading: false, leading: text.fontSize * text.lineHeight, tracking: text.letterSpacing / text.fontSize * 1000,
          fillColor: { r: parseInt(text.color.slice(1, 3), 16), g: parseInt(text.color.slice(3, 5), 16), b: parseInt(text.color.slice(5, 7), 16) } },
        paragraphStyle: { justification: text.align },
      } } : {}),
    });
  }
  const merged = await decodeLayerImage(await renderLayerDocument(document));
  const canvas = window.document.createElement("canvas"); canvas.width = document.width; canvas.height = document.height;
  canvas.getContext("2d")!.drawImage(merged, 0, 0);
  return writePsdUint8Array({ width: document.width, height: document.height, children, canvas }, { generateThumbnail: true, noBackground: true });
}

export function exportBytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
