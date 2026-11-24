import { api } from "./api";
import type { AnnotationMeta, Asset, EditableAnnotation } from "./types";

export const draftAnnotationBase = { kind: "draft", width: 1600, height: 1200, background: "#ffffff" } as const;

type StoredImage = { url: string; sha256?: string };

export async function annotationImageHash(image: StoredImage): Promise<string> {
  if (image.sha256) return image.sha256;
  const separator = image.url.indexOf(",");
  const source = image.url.slice(separator + 1);
  const bytes = image.url.slice(0, separator).endsWith(";base64")
    ? Uint8Array.from(atob(source), char => char.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(source));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function blankAnnotationImage(base: Extract<EditableAnnotation["base"], { kind: "draft" }> = draftAnnotationBase): StoredImage {
  const canvas = document.createElement("canvas");
  canvas.width = base.width;
  canvas.height = base.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建草稿底图");
  context.fillStyle = base.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return { url: canvas.toDataURL("image/png") };
}

async function readStoredImage(path: string): Promise<StoredImage> {
  // HEIC is normalized to PNG by the local reader. Its version still refers to the original file.
  if (/\.hei[cf]$/i.test(path)) return api.readAnnotationImageWithHash(path);
  return { url: await api.readImageDataUrl(path) };
}

type AnnotationDocument = { meta: AnnotationMeta; editable: EditableAnnotation };

export interface AnnotationEditImage {
  image: StoredImage;
  document?: AnnotationDocument;
  revision?: { annotationId: string; sourceHash: string };
  warning?: string;
}

function parseAnnotation(payload: string): AnnotationMeta | null {
  try {
    const meta = JSON.parse(payload) as AnnotationMeta | null;
    return meta?.schema_version === 1 ? meta : null;
  } catch {
    return null;
  }
}

const pictureTools = new Set(["rect", "arrow", "ellipse", "pencil", "text", "line", "marker", "mosaic", "blur", "eraser"]);

function readEditable(meta: AnnotationMeta): EditableAnnotation | null {
  const editable = meta.editable;
  if (!editable?.base || !Array.isArray(editable.shapes)) return null;
  const { base, shapes } = editable;
  if (base.kind !== "asset" && !(base.kind === "draft" && base.background === "#ffffff"
    && Number.isInteger(base.width) && Number.isInteger(base.height)
    && base.width > 0 && base.width <= 4096 && base.height > 0 && base.height <= 4096)) return null;
  if (!shapes.every(shape => shape && pictureTools.has(shape.type) && typeof shape.color === "string"
    && [shape.x1, shape.y1, shape.x2, shape.y2, shape.strokeRatio].every(Number.isFinite)
    && (shape.type !== "text" || (
      typeof shape.text === "string" && typeof shape.textSource === "string" && typeof shape.fontFamily === "string"
      && [shape.fontRatio, shape.textWidthRatio, shape.fontWeight].every(Number.isFinite)
      && Array.isArray(shape.points) && shape.points.length >= 3
    ))
    && (shape.points === undefined || (Array.isArray(shape.points) && shape.points.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y)))))) return null;
  if (meta.transform !== undefined && (!Array.isArray(meta.transform) || !meta.transform.every(op => op && (
    (op.kind === "rotate" && (op.dir === 1 || op.dir === -1))
    || (op.kind === "flip" && (op.axis === "horizontal" || op.axis === "vertical"))
    || (op.kind === "crop" && [op.x1, op.y1, op.x2, op.y2].every(value => Number.isFinite(value) && value >= 0 && value <= 1)
      && op.x2 > op.x1 && op.y2 > op.y1)
  )))) return null;
  return editable;
}

export async function loadAnnotationImage(asset: Asset, path: string): Promise<AnnotationEditImage> {
  const [image, analyses] = await Promise.all([
    readStoredImage(path),
    asset.source === "annotation" ? api.listAnalysesByAsset(asset.id) : [],
  ]);
  const latest = analyses.find(analysis => analysis.kind === "annotation");
  const meta = latest && parseAnnotation(latest.payload);
  if (!latest || !meta || meta.save_mode === "overwrite" || (!meta.editable && meta.save_mode !== "revision")) return { image };

  const sourceHash = await annotationImageHash(image);
  const revision = { annotationId: latest.id, sourceHash };
  if (!meta.editable) return { image, revision };
  const flat = (warning: string): AnnotationEditImage => ({ image, revision, warning });
  if (meta.output_sha256 !== sourceHash) return flat("标注图已变更，将以当前扁平图继续标注。");
  const editable = readEditable(meta);
  if (!editable) return flat("无法恢复标注编辑文档，将以当前扁平图继续标注。");
  const document = { meta, editable };
  if (editable.base.kind === "draft") return { image: blankAnnotationImage(editable.base), document, revision };

  if (meta.source_asset_id && meta.source_asset_id !== asset.id && meta.source_sha256) {
    try {
      const sources = await api.getAssetsByIds([meta.source_asset_id]);
      const source = sources.find(item => item.id === meta.source_asset_id);
      if (source?.store_path) {
        const cleanImage = await readStoredImage(source.store_path);
        if (await annotationImageHash(cleanImage) === meta.source_sha256) {
          return { image: cleanImage, document: { ...document, meta: { ...meta, source_store_path: source.store_path } }, revision };
        }
      }
    } catch {
      // The finished raster remains usable if its clean source cannot be read.
    }
  }
  return flat("原图已变更或不可用，将以当前扁平图继续标注。");
}
