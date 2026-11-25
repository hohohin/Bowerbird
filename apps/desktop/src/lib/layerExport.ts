import { decodeLayerImage, renderLayerDocumentCanvas, renderTextLayer, styledLayerTextSpans, type LayerDocument, type LayerText } from "./layerDocument";

function psdTextStyle(style: Pick<LayerText, "fontFamily" | "color" | "bold" | "italic" | "underline" | "strikethrough">, fontNames: Record<string, string>): import("ag-psd").TextStyle {
  return {
    font: { name: fontNames[style.fontFamily] ?? style.fontFamily }, fauxBold: style.bold, fauxItalic: !!style.italic,
    underline: !!style.underline, strikethrough: !!style.strikethrough,
    fillColor: { r: parseInt(style.color.slice(1, 3), 16), g: parseInt(style.color.slice(3, 5), 16), b: parseInt(style.color.slice(5, 7), 16) },
  };
}

/** PSD keeps a pixel preview for each layer as well as editable type metadata. */
export async function exportLayerPsd(document: LayerDocument, fontNames: Record<string, string> = {}): Promise<Uint8Array> {
  const extents = document.layers.map(layer => ({
    width: Math.ceil(layer.x + layer.width) - Math.floor(layer.x),
    height: Math.ceil(layer.y + layer.height) - Math.floor(layer.y),
  }));
  const pixels = document.width * document.height + extents.reduce((sum, { width, height }) => sum + width * height, 0);
  // ag-psd retains each backing canvas during serialization. Keep the budget based on pixels, independent of layer count.
  if (pixels > 64_000_000 || extents.some(({ width, height }) => width > 30000 || height > 30000)) {
    throw new Error("图层尺寸过大，无法安全导出 PSD，请缩小图层后重试");
  }
  const { writePsdUint8Array } = await import("ag-psd");
  const children: import("ag-psd").Layer[] = [];
  // ag-psd serializes children bottom-to-top (Photoshop's DOM reads them reversed).
  for (const [index, layer] of document.layers.entries()) {
    const left = Math.floor(layer.x), top = Math.floor(layer.y);
    const canvas = window.document.createElement("canvas");
    canvas.width = extents[index].width; canvas.height = extents[index].height;
    const text = layer.text;
    const spans = text ? styledLayerTextSpans(text) : [];
    const nonblank = spans.filter(({ content }) => content.trim());
    const shadow = nonblank.length > 0 && nonblank.every(({ style }) => style.shadow);
    const pixelText = shadow && text ? { ...text, shadow: false, runs: text.runs?.map(run => ({ ...run, shadow: false })) } : text;
    const image = await decodeLayerImage(pixelText ? await renderTextLayer(pixelText) : layer.dataUrl);
    canvas.getContext("2d")!.drawImage(image, layer.x - left, layer.y - top, layer.width, layer.height);
    const visibleFontSize = text ? text.fontSize * layer.height / text.boxHeight : 0;
    children.push({ name: layer.name, left, top, canvas, hidden: !layer.visible, opacity: layer.opacity, blendMode: "normal",
      ...(shadow ? { effects: { dropShadow: [{ enabled: true, present: true, useGlobalLight: false,
        angle: 90, distance: { units: "Pixels", value: visibleFontSize * .08 }, size: { units: "Pixels", value: visibleFontSize * .1 },
        color: { r: 0, g: 0, b: 0 }, opacity: .4, blendMode: "multiply" }] } } : {}),
      ...(text ? { text: {
        text: text.content.replace(/\n/g, "\r"),
        transform: [layer.width / text.boxWidth, 0, 0, layer.height / text.boxHeight, layer.x, layer.y],
        shapeType: "box" as const, boxBounds: [0, 0, text.boxWidth, text.boxHeight],
        antiAlias: "smooth" as const,
        style: { ...psdTextStyle(text, fontNames), fontSize: text.fontSize,
          autoLeading: false, leading: text.fontSize * text.lineHeight, tracking: text.letterSpacing / text.fontSize * 1000 },
        ...(text.runs?.length ? { styleRuns: spans.map(({ content, style }) => ({ length: content.length, style: psdTextStyle(style, fontNames) })) } : {}),
        paragraphStyle: { justification: text.align },
      } } : {}),
    });
  }
  const canvas = await renderLayerDocumentCanvas(document);
  return writePsdUint8Array({ width: document.width, height: document.height, children, canvas }, { generateThumbnail: true, noBackground: true });
}

export function exportBytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
