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
  /** OCR coordinates use the original output bottom image as their reference. */
  textRecognition?: LayerTextRecognition;
  /** dataUrl remains the original raster so conversion can always be reversed. */
  text?: LayerText;
  /** Retained while showing the raster; switching back restores all text edits. */
  textBackup?: LayerText;
}

interface LayerTextStyle {
  fontFamily: string;
  color: string;
  bold: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  shadow?: boolean;
}

interface LayerTextRun extends Partial<LayerTextStyle> {
  /** Start and end are UTF-16 offsets, like a textarea selection. */
  start: number;
  end: number;
}

interface LayerTextRecognition {
  text: string;
  lines: {
    bounding_box: { absolute?: number[]; normalized?: number[] };
    runs: {
      text: string;
      style?: {
        similar_font_family?: string;
        foreground_color?: string;
        bold?: boolean;
        italic?: boolean;
        underline?: boolean;
        strikethrough?: boolean;
        shadow?: boolean;
        translucent?: boolean;
      };
    }[];
  }[];
}

export interface LayerText extends LayerTextStyle {
  content: string;
  fontSize: number;
  align: "left" | "center" | "right";
  lineHeight: number;
  letterSpacing: number;
  boxWidth: number;
  boxHeight: number;
  runs?: LayerTextRun[];
}

const textStyleKeys = ["fontFamily", "color", "bold", "italic", "underline", "strikethrough", "shadow"] as const;

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
  layer_options: { operation: "decompose" | "edit" | "generate"; size: "auto" | "1K" | "1.5K" | "2K"; max_images?: number; text_recognition?: boolean };
}

export interface LayerWorkspace {
  document: LayerDocument | null;
  pending: { request: LayerRequest; userId: string; layerId: string | null } | null;
  textPending?: TextRecognitionPending | null;
  history?: {
    images: string[];
    documents: (Omit<LayerDocument, "layers"> & { layers: (Omit<ImageLayer, "dataUrl"> & { image: number })[] })[];
    redoDocuments?: NonNullable<LayerWorkspace["history"]>["documents"];
  };
}

// Negative image indexes reuse the current document; older pixels are stored once.
export function packLayerHistory(document: LayerDocument | null, history: LayerDocument[], redo: LayerDocument[] = []): NonNullable<LayerWorkspace["history"]> {
  const images: string[] = [];
  const indexes = new Map(document?.layers.map((layer, index) => [layer.dataUrl, -index - 1]));
  const pack = (stack: LayerDocument[]) => stack.slice(-30).map(snapshot => ({ ...snapshot, layers: snapshot.layers.map(({ dataUrl, ...layer }) => {
    let image = indexes.get(dataUrl);
    if (image === undefined) { image = images.length; images.push(dataUrl); indexes.set(dataUrl, image); }
    return { ...layer, image };
  }) }));
  return { images, documents: pack(history), ...(redo.length ? { redoDocuments: pack(redo) } : {}) };
}

export function unpackLayerHistory(workspace: LayerWorkspace, stack: "documents" | "redoDocuments" = "documents"): LayerDocument[] {
  return workspace.history?.[stack]?.map(snapshot => ({ ...snapshot, layers: snapshot.layers.map(({ image, ...layer }) => ({
    ...layer, dataUrl: image < 0 ? workspace.document!.layers[-image - 1].dataUrl : workspace.history!.images[image],
  })) })) ?? [];
}

export function isTextLayer(layer: ImageLayer): boolean {
  return !layer.background && (!!layer.text || !!layer.textRecognition || /文字|标题|文案|字样|标语|字幕|文本|字母|text|title|headline|lettering|typography/i.test(`${layer.name} ${layer.description}`));
}

export function parseRecognizedText(raw: string): { content: string; color: string; bold: boolean; align: LayerText["align"] } {
  const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  if (typeof value.text !== "string" || value.text.length > 5000) throw new Error("文字识别结果无效，原图层已保留");
  if (!value.text.trim()) throw new Error("未识别到清晰文字，原图层已保留");
  return { content: value.text, color: /^#[\da-f]{6}$/i.test(value.color) ? value.color : "#222222", bold: value.bold === true, align: ["left", "center", "right"].includes(value.alignment) ? value.alignment : "left" };
}

export function textFont(text: LayerTextStyle & Pick<LayerText, "fontSize">): string {
  return `${text.italic ? "italic " : ""}${text.bold ? 700 : 400} ${text.fontSize}px ${JSON.stringify(text.fontFamily)}, sans-serif`;
}

export function textLayerFromRecognition(layer: ImageLayer, fonts: string[], documentSize: Pick<LayerDocument, "width" | "height">): { text: LayerText; missingFonts: string[] } | null {
  const recognition = layer.textRecognition;
  if (!recognition?.text.trim() || recognition.text.length > 5000) return null;
  const content = recognition.text;
  const missingFonts = new Set<string>();
  const installed = new Map(fonts.map(font => [font.normalize("NFKC").toLowerCase(), font]));
  const fallbackFont = ["Microsoft YaHei", "微软雅黑", "PingFang SC", "Arial"].find(font => fonts.includes(font)) ?? fonts[0] ?? "Arial";
  const defaultStyle: LayerTextStyle = { fontFamily: fallbackFont, color: "#222222", bold: false };
  const recognizedRuns: (LayerTextRun & LayerTextStyle)[] = [];
  const lineBounds: { top: number; height: number }[] = [];
  let offset = 0;
  for (const [index, line] of content.split("\n").entries()) {
    const source = recognition.lines[index];
    if (source?.runs.map(run => run.text).join("") === line) {
      const absolute = source.bounding_box.absolute;
      const bounds = absolute ?? source.bounding_box.normalized?.map((value, i) => value * (i % 2 ? documentSize.height : documentSize.width) / 1000);
      if (bounds && bounds[3] > bounds[1]) lineBounds.push({ top: bounds[1], height: bounds[3] - bounds[1] });
      let start = offset;
      for (const run of source.runs) {
        if (!run.text) continue;
        const style = run.style;
        const suggestedFont = style?.similar_font_family?.trim();
        const family = suggestedFont && installed.get(suggestedFont.normalize("NFKC").toLowerCase());
        if (!family && suggestedFont && suggestedFont.toLowerCase() !== "unknown") missingFonts.add(suggestedFont);
        const end = start + run.text.length;
        recognizedRuns.push({ start, end, fontFamily: family || fallbackFont,
          color: /^#[\da-f]{6}$/i.test(style?.foreground_color ?? "") ? style!.foreground_color!.toLowerCase() : defaultStyle.color,
          bold: style?.bold === true, italic: style?.italic === true, underline: style?.underline === true,
          strikethrough: style?.strikethrough === true, shadow: style?.shadow === true });
        start = end;
      }
    }
    offset += line.length + 1;
  }
  const { start: _start, end: _end, ...style } = recognizedRuns[0] ?? { ...defaultStyle, start: 0, end: 0 };
  const runs = recognizedRuns.flatMap(run => {
    const overrides = Object.fromEntries(textStyleKeys.filter(key => run[key] !== style[key]).map(key => [key, run[key]]));
    return Object.keys(overrides).length ? [{ start: run.start, end: run.end, ...overrides }] : [];
  });
  const boxWidth = Math.max(1, Math.min(6000, Math.round(layer.width)));
  const boxHeight = Math.max(1, Math.min(6000, Math.round(layer.height)));
  const lineCount = content.split("\n").length;
  const heights = lineBounds.map(line => line.height).sort((a, b) => a - b);
  const fontSize = Math.max(1, Math.min(2000, Math.round(heights[Math.floor(heights.length / 2)] ?? boxHeight / (lineCount * 1.2))));
  const lineInterval = (lineBounds[lineBounds.length - 1]?.top ?? 0) - (lineBounds[0]?.top ?? 0);
  const lineHeight = lineBounds.length > 1 && lineInterval > 0 ? Math.max(.5, Math.min(5, lineInterval / (lineBounds.length - 1) / fontSize)) : 1.2;
  return { text: { ...style, content, fontSize, align: "left", lineHeight, letterSpacing: 0, boxWidth, boxHeight, ...(runs.length ? { runs } : {}) }, missingFonts: [...missingFonts] };
}

/** Keep the formatting of untouched text when a plain textarea edits one range. */
export function patchLayerText(text: LayerText, patch: Partial<LayerText>): LayerText {
  const next = { ...text, ...patch };
  if (!text.runs?.length || patch.runs) return next;
  const before = Array.from(text.content), after = Array.from(next.content);
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const startOfEdit = before.slice(0, prefix).join("").length;
  const endOfEdit = text.content.length - before.slice(before.length - suffix).join("").length;
  const delta = next.content.length - text.content.length;
  const endOfInsertion = endOfEdit + delta;
  const runs: LayerTextRun[] = [];
  for (const { start, end, ...style } of text.runs) {
    for (const key of textStyleKeys) if (key in patch) delete style[key];
    if (!Object.keys(style).length) continue;
    const includesInsertion = start <= startOfEdit && (startOfEdit < end || end === text.content.length);
    const leftEnd = includesInsertion ? endOfInsertion : Math.min(end, startOfEdit);
    if (start < startOfEdit || includesInsertion) {
      if (start < leftEnd) runs.push({ ...style, start, end: leftEnd });
    }
    const rightStart = Math.max(start, endOfEdit) + delta;
    if (rightStart < end + delta) {
      const left = runs[runs.length - 1];
      if (includesInsertion && left?.end === rightStart) left.end = end + delta;
      else runs.push({ ...style, start: rightStart, end: end + delta });
    }
  }
  return { ...next, runs: runs.length ? runs : undefined };
}

export function styledLayerTextSpans(text: LayerText): { content: string; style: LayerTextStyle }[] {
  const spans = [];
  let offset = 0;
  for (const { start, end, ...style } of text.runs ?? []) {
    if (offset < start) spans.push({ content: text.content.slice(offset, start), style: text });
    spans.push({ content: text.content.slice(start, end), style: { ...text, ...style } });
    offset = end;
  }
  if (offset < text.content.length) spans.push({ content: text.content.slice(offset), style: text });
  return spans;
}

export function layerTextFontFamilies(text: LayerText): string[] {
  return [...new Set([text.fontFamily, ...(text.runs ?? []).flatMap(run => run.fontFamily ?? [])])];
}

export async function loadLayerTextFonts(text: LayerText): Promise<void> {
  const fonts = new Set([textFont(text), ...styledLayerTextSpans(text).map(({ style }) => textFont({ ...style, fontSize: text.fontSize }))]);
  await Promise.all([...fonts].map(font => window.document.fonts.load(font)));
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
  context.save();
  context.clearRect(0, 0, text.boxWidth, text.boxHeight);
  context.textBaseline = "top";
  context.letterSpacing = `${text.letterSpacing}px`;
  const lines: { content: string; style: LayerTextStyle; width: number }[][] = [[]];
  let lineWidth = 0;
  function newLine() { lines.push([]); lineWidth = 0; }
  for (const { content, style } of styledLayerTextSpans(text)) {
    context.font = textFont({ ...style, fontSize: text.fontSize });
    for (const character of content) {
      if (character === "\n") { newLine(); continue; }
      let line = lines[lines.length - 1];
      let previous: (typeof line)[number] | undefined = line[line.length - 1];
      let chunk = previous?.style === style ? previous.content + character : character;
      let width = context.measureText(chunk).width;
      if (line.length && lineWidth + width - (previous?.style === style ? previous.width : 0) > text.boxWidth) {
        newLine(); line = lines[lines.length - 1]; previous = undefined;
        chunk = character; width = context.measureText(chunk).width;
      }
      if (previous?.style === style) {
        lineWidth += width - previous.width;
        previous.content = chunk; previous.width = width;
      } else {
        line.push({ content: chunk, style, width }); lineWidth += width;
      }
    }
  }
  lines.forEach((line, index) => {
    const width = line.reduce((sum, span) => sum + span.width, 0);
    let x = text.align === "center" ? (text.boxWidth - width) / 2 : text.align === "right" ? text.boxWidth - width : 0;
    const y = index * text.fontSize * text.lineHeight;
    for (const { content, style, width } of line) {
      context.font = textFont({ ...style, fontSize: text.fontSize });
      context.fillStyle = style.color;
      context.shadowColor = style.shadow ? "rgba(0, 0, 0, 0.4)" : "transparent";
      context.shadowBlur = text.fontSize * .1;
      context.shadowOffsetY = text.fontSize * .08;
      context.fillText(content, x, y);
      const thickness = Math.max(1, text.fontSize * .045);
      if (style.underline) context.fillRect(x, y + text.fontSize * .95, width, thickness);
      if (style.strikethrough) context.fillRect(x, y + text.fontSize * .52, width, thickness);
      x += width;
    }
  });
  context.restore();
}

export async function renderTextLayer(text: LayerText): Promise<string> {
  await loadLayerTextFonts(text);
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
  return (await renderLayerDocumentCanvas(document)).toDataURL("image/png");
}

export async function renderLayerDocumentCanvas(document: LayerDocument): Promise<HTMLCanvasElement> {
  const canvas = window.document.createElement("canvas");
  canvas.width = document.width;
  canvas.height = document.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建合成画布");
  // Decode and release one layer at a time; a broken layer still rejects the whole export.
  for (const layer of document.layers) {
    if (!layer.visible) continue;
    const image = await decodeLayerImage(layer.text ? await renderTextLayer(layer.text) : layer.dataUrl);
    context.globalAlpha = layer.opacity;
    context.drawImage(image, layer.x, layer.y, layer.width, layer.height);
  }
  return canvas;
}
