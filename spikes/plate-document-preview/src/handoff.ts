import type { DocumentBlock, DocumentText, DocumentValue, DraftTarget, MediaKind, PreviewAsset } from "./domain.ts";

export interface HandoffInput {
  requestId: string;
  projectId: string;
  target: DraftTarget;
  sourceDocumentAssetId: string;
  sourceRevision: string;
  value: DocumentValue;
  assets: readonly PreviewAsset[];
  /** Omitted means the whole document; an empty array means no selected blocks. */
  selectedBlockIds?: readonly string[];
}

export interface DraftReference {
  asset: PreviewAsset;
  label: string;
  blockIds: string[];
  supported: boolean;
}

export interface MissingReference {
  blockId: string;
  assetId?: string;
  name: string;
  reason: "not-found" | "unlinked" | "kind-mismatch" | "unsupported-block";
}

export interface DocumentHandoff {
  mode: "draft";
  requestId: string;
  projectId: string;
  target: DraftTarget;
  source: { assetId: string; revision: string; blockIds: string[] };
  text: string;
  references: DraftReference[];
  unsupported: { assetId: string; name: string; label: string; kind: MediaKind }[];
  missing: MissingReference[];
}

// Preview profiles: chat and Agent use the existing local image-capable path.
// Production adapters must resolve support from the selected provider and mode.
const SUPPORTED_MEDIA: Record<DraftTarget, readonly MediaKind[]> = {
  chat: ["image"], agent: ["image"], image: ["image"], video: ["image", "video"],
};
const MEDIA_LABELS: Record<MediaKind, string> = { image: "图片", audio: "音频", video: "视频" };
const MEDIA_TYPES = new Map<string, MediaKind>([["img", "image"], ["audio", "audio"], ["video", "video"]]);

function isBlock(node: DocumentBlock | DocumentText): node is DocumentBlock {
  return typeof node.type === "string" && Array.isArray(node.children);
}

function selectBlocks(blocks: DocumentValue, selected: ReadonlySet<string>): DocumentValue {
  return blocks.flatMap(block => selected.has(block.id)
    ? [block]
    : selectBlocks(block.children.filter(isBlock), selected));
}

function missingReason(block: DocumentBlock, asset: PreviewAsset | undefined): MissingReference["reason"] | null {
  const kind = MEDIA_TYPES.get(block.type);
  if (!kind) return "unsupported-block";
  if (!block.assetId) return "unlinked";
  if (!asset) return "not-found";
  return asset.kind === kind ? null : "kind-mismatch";
}

interface SerializationContext {
  target: DraftTarget;
  assets: ReadonlyMap<string, PreviewAsset>;
  references: Map<string, DraftReference>;
  counters: Record<MediaKind, number>;
  missing: MissingReference[];
}

function mediaText(block: DocumentBlock, context: SerializationContext): string {
  const asset = block.assetId ? context.assets.get(block.assetId) : undefined;
  const reason = missingReason(block, asset);
  if (reason || !asset) {
    const name = block.caption || asset?.name || "未连接素材";
    context.missing.push({ blockId: block.id, assetId: block.assetId, name, reason: reason ?? "not-found" });
    return `（素材未连接：${name}）`;
  }
  let reference = context.references.get(asset.id);
  if (!reference) {
    reference = {
      asset: { ...asset }, label: `${MEDIA_LABELS[asset.kind]}${++context.counters[asset.kind]}`,
      blockIds: [], supported: SUPPORTED_MEDIA[context.target].includes(asset.kind),
    };
    context.references.set(asset.id, reference);
  }
  reference.blockIds.push(block.id);
  const caption = block.caption?.trim();
  return `@${reference.label}${caption ? `：${caption}` : ""}`;
}

function blockText(block: DocumentBlock, context: SerializationContext): string {
  if (MEDIA_TYPES.has(block.type) || block.assetId) return mediaText(block, context);
  return block.children.map((child, index) => {
    if (!isBlock(child)) return child.text;
    return `${index > 0 ? "\n\n" : ""}${blockText(child, context)}`;
  }).join("").trim();
}

export function createHandoff(input: HandoffInput): DocumentHandoff {
  const blocks = input.selectedBlockIds === undefined
    ? input.value
    : selectBlocks(input.value, new Set(input.selectedBlockIds));
  const context: SerializationContext = {
    target: input.target, assets: new Map(input.assets.map(asset => [asset.id, asset])),
    references: new Map(), counters: { image: 0, audio: 0, video: 0 }, missing: [],
  };
  const text = blocks.map(block => blockText(block, context)).filter(Boolean).join("\n\n");
  const references = Array.from(context.references.values());
  return {
    mode: "draft",
    requestId: input.requestId,
    projectId: input.projectId,
    target: input.target,
    source: {
      assetId: input.sourceDocumentAssetId, revision: input.sourceRevision,
      blockIds: blocks.map(block => block.id),
    },
    text,
    references,
    unsupported: references.filter(ref => !ref.supported).map(ref => ({
      assetId: ref.asset.id, name: ref.asset.name, label: ref.label, kind: ref.asset.kind,
    })),
    missing: context.missing,
  };
}
