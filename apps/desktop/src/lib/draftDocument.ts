import { decodeLayerImage, paintLayerText, textFont, type LayerDocument, type LayerText } from "./layerDocument";
import { draftSelectionToLayer, type DraftSelection } from "./draftSelection";

export const DRAFT_MAX_SIDE = 4096;
export const DRAFT_MAX_LAYERS = 32;
export const DRAFT_MAX_PIXELS = 64_000_000;

export interface DraftLayer {
  id: string;
  name: string;
  kind: "raster" | "text";
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  dataUrl?: string;
  text?: LayerText;
}
export interface DraftDocument {
  schemaVersion: 1;
  documentId: string;
  width: number;
  height: number;
  layers: DraftLayer[];
  backgroundLayerId?: string;
}
export type DraftSurface = Omit<DraftLayer, "dataUrl"> & { canvas: HTMLCanvasElement };
export type DraftWorkingDocument = Omit<DraftDocument, "layers"> & { layers: DraftSurface[] };
export type DraftRect = { x: number; y: number; width: number; height: number };

function checkDraftSize(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > DRAFT_MAX_SIDE || height > DRAFT_MAX_SIDE) {
    throw new Error("画布宽高需为 1 到 4096 的整数");
  }
}

export function draftCanvas(width: number, height: number): HTMLCanvasElement {
  checkDraftSize(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  return canvas;
}

export function rasterLayer(width: number, height: number, name = "绘画图层"): DraftSurface {
  return { id: crypto.randomUUID(), name, kind: "raster", x: 0, y: 0, width, height, opacity: 1,
    visible: true, locked: false, canvas: draftCanvas(width, height) };
}

function whiteBackground(width: number, height: number): DraftSurface {
  const background = rasterLayer(width, height, "背景");
  background.locked = true;
  const context = background.canvas.getContext("2d")!;
  context.fillStyle = "#ffffff"; context.fillRect(0, 0, width, height);
  return background;
}

export function newDraftDocument(width: number, height: number, transparent: boolean): DraftWorkingDocument {
  const layers: DraftSurface[] = transparent ? [] : [whiteBackground(width, height)];
  layers.push(rasterLayer(width, height));
  return { schemaVersion: 1, documentId: crypto.randomUUID(), width, height, layers,
    ...(!transparent ? { backgroundLayerId: layers[0].id } : {}) };
}

function applyDraftCrop(doc: DraftWorkingDocument, rect: DraftRect, transparent?: boolean): DraftWorkingDocument {
  const { width, height } = rect;
  checkDraftSize(width, height);
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) throw new Error("裁剪位置无效");
  const background = doc.layers.find(layer => layer.id === doc.backgroundLayerId);
  const addBackground = transparent === false && !background;
  const plans = doc.layers.map(layer => {
    const spansCanvas = layer.kind === "raster" && layer.x <= 0 && layer.y <= 0
      && layer.width === layer.canvas.width && layer.height === layer.canvas.height
      && layer.x + layer.width >= doc.width && layer.y + layer.height >= doc.height;
    // Align extension to this layer's pixel grid so translated artwork is never resampled.
    const left = spansCanvas ? Math.max(0, Math.ceil(layer.x - rect.x)) : 0;
    const top = spansCanvas ? Math.max(0, Math.ceil(layer.y - rect.y)) : 0;
    const right = spansCanvas ? Math.max(0, Math.ceil(rect.x + width - layer.x - layer.width)) : 0;
    const bottom = spansCanvas ? Math.max(0, Math.ceil(rect.y + height - layer.y - layer.height)) : 0;
    const x = layer.x - left, y = layer.y - top;
    const bufferWidth = layer.canvas.width + left + right;
    const bufferHeight = layer.canvas.height + top + bottom;
    if (bufferWidth > DRAFT_MAX_SIDE || bufferHeight > DRAFT_MAX_SIDE) {
      throw new Error("保留画布外内容后的图层边长超过 4096，请缩小裁剪范围后重试");
    }
    if (!Number.isFinite(x - rect.x) || !Number.isFinite(y - rect.y)
      || Math.abs(x - rect.x) > 100_000 || Math.abs(y - rect.y) > 100_000) throw new Error("裁剪范围离原画布过远，请移近后重试");
    return { layer, x, y, width: bufferWidth, height: bufferHeight };
  });
  if (plans.length + Number(addBackground) > DRAFT_MAX_LAYERS) throw new Error("草稿最多支持 32 个图层，请删除不需要的图层后重试");
  if (plans.reduce((sum, p) => sum + p.width * p.height, addBackground ? width * height : 0) > DRAFT_MAX_PIXELS) {
    throw new Error("图层总尺寸过大，请缩小画布或删除不需要的图层后重试");
  }
  let changed = width !== doc.width || height !== doc.height || rect.x !== 0 || rect.y !== 0;
  const layers = plans.map(plan => {
    let layer = plan.layer;
    if (plan.width !== layer.canvas.width || plan.height !== layer.canvas.height) {
      const canvas = draftCanvas(plan.width, plan.height), context = canvas.getContext("2d")!;
      const offsetX = layer.x - plan.x, offsetY = layer.y - plan.y;
      if (layer.id === doc.backgroundLayerId) {
        context.fillStyle = "#ffffff"; context.fillRect(0, 0, plan.width, plan.height);
        context.clearRect(offsetX, offsetY, layer.canvas.width, layer.canvas.height);
      }
      context.drawImage(layer.canvas, offsetX, offsetY);
      layer = { ...layer, width: plan.width, height: plan.height, canvas }; changed = true;
    }
    const x = plan.x - rect.x, y = plan.y - rect.y;
    if (layer.x !== x || layer.y !== y) layer = { ...layer, x, y };
    if (transparent !== undefined && layer.id === doc.backgroundLayerId && layer.visible === transparent) {
      layer = { ...layer, visible: !transparent }; changed = true;
    }
    return layer;
  });
  let backgroundLayerId = doc.backgroundLayerId;
  if (addBackground) {
    const layer = whiteBackground(width, height);
    layers.unshift(layer); backgroundLayerId = layer.id; changed = true;
  }
  return changed ? { ...doc, width, height, layers, backgroundLayerId } : doc;
}

/** Non-destructive crop/extension: retain off-canvas pixels and move layers into the new origin. */
export function cropDraftDocument(doc: DraftWorkingDocument, rect: DraftRect): DraftWorkingDocument {
  return applyDraftCrop(doc, rect);
}

/** Compatibility for top-left size/background controls; new crop UI uses cropDraftDocument. */
export function resizeDraftDocument(doc: DraftWorkingDocument, width: number, height: number, transparent: boolean): DraftWorkingDocument {
  return applyDraftCrop(doc, { x: 0, y: 0, width, height }, transparent);
}

export function checkDraftBudget(doc: DraftWorkingDocument) {
  if (doc.layers.length > DRAFT_MAX_LAYERS) throw new Error("草稿最多支持 32 个图层，请删除不需要的图层后重试");
  if (doc.layers.reduce((n, layer) => n + layer.canvas.width * layer.canvas.height, 0) > DRAFT_MAX_PIXELS) {
    throw new Error("图层总尺寸过大，请缩小图片或删除不需要的图层后重试");
  }
}

export async function openDraftDocument(saved: DraftDocument): Promise<DraftWorkingDocument> {
  if (saved.schemaVersion !== 1 || !Array.isArray(saved.layers) || saved.layers.length > DRAFT_MAX_LAYERS) {
    throw new Error("草稿工程格式不支持，请更新应用后重试");
  }
  // Check dimensions before decoding or allocating raster buffers.
  checkDraftSize(saved.width, saved.height);
  const layers: DraftSurface[] = [];
  for (const { dataUrl, ...layer } of saved.layers) {
    if (layer.kind === "text" && layer.text) {
      const canvas = draftCanvas(layer.text.boxWidth, layer.text.boxHeight);
      await document.fonts.load(textFont(layer.text));
      layers.push({ ...layer, canvas });
    } else if (layer.kind === "raster" && dataUrl) {
      const image = await decodeLayerImage(dataUrl);
      const canvas = draftCanvas(image.naturalWidth, image.naturalHeight);
      canvas.getContext("2d")!.drawImage(image, 0, 0);
      layers.push({ ...layer, canvas });
    } else throw new Error("草稿图层不完整，请重新打开工程");
    checkDraftBudget({ ...saved, layers });
  }
  // Older snapshots used the default locked first layer before an explicit background ID existed.
  const first = layers[0];
  const backgroundLayerId = saved.backgroundLayerId ?? (first?.kind === "raster" && first.name === "背景" && first.locked
    && first.x === 0 && first.y === 0 && first.width === saved.width && first.height === saved.height ? first.id : undefined);
  return { ...saved, layers, backgroundLayerId };
}

export function serializeDraft(doc: DraftWorkingDocument): DraftDocument {
  checkDraftBudget(doc);
  return { ...doc, layers: doc.layers.map(({ canvas, ...layer }) => ({ ...layer,
    ...(layer.kind === "raster" ? { dataUrl: canvas.toDataURL("image/png") } : {}) })) };
}

const textPainted = new WeakMap<HTMLCanvasElement, LayerText>();
export function layerSurface(layer: DraftSurface): HTMLCanvasElement {
  if (layer.kind === "text" && layer.text && textPainted.get(layer.canvas) !== layer.text) {
    const text = layer.text;
    if (layer.canvas.width !== text.boxWidth) layer.canvas.width = text.boxWidth;
    if (layer.canvas.height !== text.boxHeight) layer.canvas.height = text.boxHeight;
    paintLayerText(layer.canvas.getContext("2d")!, text);
    textPainted.set(layer.canvas, text);
  }
  return layer.canvas;
}

/** Display and output share this compositor; optional damage is in document pixels. */
export function paintDraft(canvas: HTMLCanvasElement, doc: DraftWorkingDocument, damage?: DraftRect) {
  if (canvas.width !== doc.width) canvas.width = doc.width;
  if (canvas.height !== doc.height) canvas.height = doc.height;
  const ctx = canvas.getContext("2d")!;
  ctx.save();
  if (damage) { ctx.beginPath(); ctx.rect(Math.floor(damage.x), Math.floor(damage.y), Math.ceil(damage.width) + 2, Math.ceil(damage.height) + 2); ctx.clip(); }
  ctx.clearRect(0, 0, doc.width, doc.height);
  for (const layer of doc.layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(layerSurface(layer), layer.x, layer.y, layer.width, layer.height);
  }
  ctx.restore();
}

export function draftPng(doc: DraftWorkingDocument): string {
  const canvas = draftCanvas(doc.width, doc.height);
  paintDraft(canvas, doc);
  return canvas.toDataURL("image/png");
}

export async function importedDraftLayer(url: string, name: string, doc: DraftWorkingDocument): Promise<DraftSurface> {
  const image = await decodeLayerImage(url);
  const layer = rasterLayer(image.naturalWidth, image.naturalHeight, name.slice(0, 200) || "图片");
  checkDraftBudget({ ...doc, layers: [...doc.layers, layer] });
  layer.canvas.getContext("2d")!.drawImage(image, 0, 0);
  const scale = Math.min(1, doc.width / layer.width, doc.height / layer.height);
  layer.width *= scale; layer.height *= scale;
  layer.x = (doc.width - layer.width) / 2; layer.y = (doc.height - layer.height) / 2;
  return layer;
}

export function duplicateDraftLayer(layer: DraftSurface): DraftSurface {
  const canvas = draftCanvas(layer.canvas.width, layer.canvas.height);
  canvas.getContext("2d")!.drawImage(layerSurface(layer), 0, 0);
  return { ...layer, id: crypto.randomUUID(), name: `${layer.name} 副本`.slice(0, 200),
    locked: false, canvas, ...(layer.text ? { text: { ...layer.text } } : {}) };
}

export function draftHit(doc: DraftWorkingDocument, x: number, y: number): DraftSurface | undefined {
  const within = (layer: DraftSurface) => layer.visible && layer.opacity > 0 && x >= layer.x && y >= layer.y && x < layer.x + layer.width && y < layer.y + layer.height;
  const top = [...doc.layers].reverse().filter(within);
  return top.find(layer => layer.kind === "text" || layerSurface(layer).getContext("2d")!.getImageData(
    Math.floor((x - layer.x) * layer.canvas.width / layer.width), Math.floor((y - layer.y) * layer.canvas.height / layer.height), 1, 1).data[3] > 8) ?? top[0];
}

export function draftSelection(a: { x: number; y: number }, b: { x: number; y: number }, doc: DraftWorkingDocument): DraftRect | null {
  const x = Math.max(0, Math.floor(Math.min(a.x, b.x))), y = Math.max(0, Math.floor(Math.min(a.y, b.y)));
  const right = Math.min(doc.width, Math.ceil(Math.max(a.x, b.x))), bottom = Math.min(doc.height, Math.ceil(Math.max(a.y, b.y)));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export function draftLayerSelection(layer: DraftSurface, selection: DraftSelection | null): DraftSelection | null {
  return selection ? draftSelectionToLayer(selection, layer) : null;
}

export function draftAsLayerDocument(doc: DraftWorkingDocument): LayerDocument {
  return { schemaVersion: 1, width: doc.width, height: doc.height, layers: doc.layers.map((layer, i) => ({
    id: layer.id, name: layer.name, description: "", dataUrl: layerSurface(layer).toDataURL("image/png"),
    x: layer.x, y: layer.y, width: layer.width, height: layer.height, opacity: layer.opacity, visible: layer.visible,
    background: i === 0, ...(layer.text ? { text: layer.text } : {}),
  })) };
}
