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
  const images = await Promise.all(visible.map(layer => decodeLayerImage(layer.dataUrl)));
  visible.forEach((layer, index) => {
    context.globalAlpha = layer.opacity;
    context.drawImage(images[index], layer.x, layer.y, layer.width, layer.height);
  });
  return canvas.toDataURL("image/png");
}
