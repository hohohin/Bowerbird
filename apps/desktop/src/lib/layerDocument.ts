export interface ImageLayer {
  id: string;
  name: string;
  description: string;
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
  background: boolean;
  /** dataUrl remains the original raster so conversion can always be reversed. */
  text?: LayerText;
  /** Retained while showing the raster; switching back restores all text edits. */
  textBackup?: LayerText;
}

export interface LayerText {
  content: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
  align: "left" | "center" | "right";
  lineHeight: number;
  letterSpacing: number;
  boxWidth: number;
  boxHeight: number;
}

export interface TextRecognitionPending {
  allowCreate?: boolean;
  idempotencyKey: string;
  userId: string;
  layerId: string;
  image: { mime: "image/jpeg"; base64: string };
}

export interface LayerDocument {
  schemaVersion: 1;
  width: number;
  height: number;
  layers: ImageLayer[]; // Bottom to top; background remains at index 0.
}

export interface LayerRequest {
  idempotency_key: string;
  media: "image";
  service: "image_layer_decompose" | "image_layer_edit";
  prompt: string;
  reference_images: { mime: string; base64: string }[];
  layer_options: { operation: "decompose" | "edit"; size: "auto" | "1K" | "1.5K" | "2K" };
}

export interface LayerWorkspace {
  document: LayerDocument | null;
  pending: { request: LayerRequest; userId: string; layerId: string | null } | null;
  textPending?: TextRecognitionPending | null;
}

export function isTextLayer(layer: ImageLayer): boolean {
  return !layer.background && (!!layer.text || /文字|标题|文案|字样|标语|字幕|文本|字母|text|title|headline|lettering|typography/i.test(`${layer.name} ${layer.description}`));
}

export function parseRecognizedText(raw: string): { content: string; color: string; bold: boolean; align: LayerText["align"] } {
  const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  if (typeof value.text !== "string" || value.text.length > 5000) throw new Error("文字识别结果无效，原图层已保留");
  if (!value.text.trim()) throw new Error("未识别到清晰文字，原图层已保留");
  return { content: value.text, color: /^#[\da-f]{6}$/i.test(value.color) ? value.color : "#222222", bold: value.bold === true, align: ["left", "center", "right"].includes(value.alignment) ? value.alignment : "left" };
}

export function textFont(text: LayerText): string {
  return `${text.bold ? 700 : 400} ${text.fontSize}px ${JSON.stringify(text.fontFamily)}, sans-serif`;
}

export async function prepareTextImage(dataUrl: string): Promise<TextRecognitionPending["image"]> {
  const image = await decodeLayerImage(dataUrl);
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = window.document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#888888"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL("image/jpeg", .9).split(",")[1];
  if (base64.length > 1_398_100) throw new Error("文字识别图片超过 1 MB，请先缩小图层");
  return { mime: "image/jpeg", base64 };
}

/** Preview and exported pixels use this same text layout; dimensions scale with the layer. */
export function paintLayerText(context: CanvasRenderingContext2D, text: LayerText) {
  context.clearRect(0, 0, text.boxWidth, text.boxHeight);
  context.font = textFont(text); context.fillStyle = text.color;
  context.textBaseline = "top";
  context.letterSpacing = `${text.letterSpacing}px`;
  const lines: string[] = [];
  for (const paragraph of text.content.split("\n")) {
    let line = "";
    for (const character of Array.from(paragraph)) {
      if (line && context.measureText(line + character).width > text.boxWidth) { lines.push(line); line = ""; }
      line += character;
    }
    lines.push(line);
  }
  lines.forEach((line, index) => {
    const width = context.measureText(line).width;
    const x = text.align === "center" ? (text.boxWidth - width) / 2 : text.align === "right" ? text.boxWidth - width : 0;
    context.fillText(line, x, index * text.fontSize * text.lineHeight);
  });
}

export async function renderTextLayer(text: LayerText): Promise<string> {
  await window.document.fonts.load(textFont(text));
  const canvas = window.document.createElement("canvas");
  canvas.width = text.boxWidth; canvas.height = text.boxHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建文字画布");
  paintLayerText(context, text);
  return canvas.toDataURL("image/png");
}

export function moveLayer(document: LayerDocument, id: string, direction: -1 | 1): LayerDocument {
  const index = document.layers.findIndex(layer => layer.id === id);
  const target = index + direction;
  if (index <= 0 || target <= 0 || target >= document.layers.length) return document;
  const layers = [...document.layers];
  [layers[index], layers[target]] = [layers[target], layers[index]];
  return { ...document, layers };
}

export function patchLayer(document: LayerDocument, id: string, patch: Partial<ImageLayer>): LayerDocument {
  return { ...document, layers: document.layers.map(layer => layer.id === id ? { ...layer, ...patch } : layer) };
}

export async function decodeLayerImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

export async function renderLayerDocument(document: LayerDocument): Promise<string> {
  const canvas = window.document.createElement("canvas");
  canvas.width = document.width;
  canvas.height = document.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建合成画布");
  // Decode every visible image before saving; a broken layer must not silently disappear.
  const visible = document.layers.filter(layer => layer.visible);
  const images = await Promise.all(visible.map(async layer => decodeLayerImage(layer.text ? await renderTextLayer(layer.text) : layer.dataUrl)));
  visible.forEach((layer, index) => {
    context.globalAlpha = layer.opacity;
    context.drawImage(images[index], layer.x, layer.y, layer.width, layer.height);
  });
  return canvas.toDataURL("image/png");
}
