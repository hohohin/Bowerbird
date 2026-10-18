import { api } from "./api";
import { containArtboardImage, type ArtboardComposition } from "./canvasArtboard";

export async function renderArtboardComposition(composition: ArtboardComposition) {
  const loaded = new Map(await Promise.all(composition.references.map(async asset => {
    const data = await api.readImageDataUrl(asset.store_path!);
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error(`无法读取原图「${asset.name}」`)); image.src = data; });
    return [asset.id, image] as const;
  })));
  const make = () => {
    const canvas = document.createElement("canvas");
    canvas.width = composition.width; canvas.height = composition.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建画板合成预览");
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
    if (composition.base) {
      const image = loaded.get(composition.base.id)!;
      const rect = containArtboardImage({ x: 0, y: 0, width: canvas.width, height: canvas.height }, image.naturalWidth, image.naturalHeight);
      context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    }
    return { canvas, context };
  };
  const preview = make(), marked = make();
  const fontSize = Math.max(14, Math.round(Math.max(composition.width, composition.height) / 65));
  composition.images.forEach((image, index) => {
    const { box, visibleBox: visible } = image;
    preview.context.drawImage(loaded.get(image.asset.id)!, box.x, box.y, box.width, box.height);
    const ctx = marked.context;
    ctx.strokeStyle = "#e02020"; ctx.lineWidth = Math.max(2, fontSize / 7);
    ctx.strokeRect(visible.x, visible.y, visible.width, visible.height);
    ctx.font = `bold ${fontSize}px sans-serif`; ctx.textBaseline = "top";
    const label = String(index + 1), labelWidth = ctx.measureText(label).width + 8;
    const x = Math.max(0, Math.min(visible.x, composition.width - labelWidth));
    const y = Math.max(0, Math.min(visible.y, composition.height - fontSize - 6));
    ctx.fillStyle = "#e02020"; ctx.fillRect(x, y, labelWidth, fontSize + 6);
    ctx.fillStyle = "white"; ctx.fillText(label, x + 4, y + 3);
  });
  return { preview: preview.canvas.toDataURL("image/png"), marked: marked.canvas.toDataURL("image/png") };
}
