import type { Node as PmNode } from "prosemirror-model";
import type { AgentPromptInput, PromptedAsset } from "../../lib/types";

/**
 * doc 扁平化后的内联节点表示（对应旧版 Token 类型，便于原样移植序列化逻辑）。
 * image 带 name（attrs 快照）作兜底：assetById 查不到时用 attrs.name（doc 自描述）。
 */
type Inline =
  | { kind: "text"; text: string }
  | { kind: "image"; assetId: string; silent?: boolean; name: string }
  | { kind: "keyword"; title: string };

/** 把 doc 扁平化成内联序列：段间插换行（多段编辑，\n 对后端 extract_dim_sections 安全）。 */
function docToInline(doc: PmNode): Inline[] {
  const flat: Inline[] = [];
  doc.forEach((para, pIdx) => {
    if (pIdx > 0) flat.push({ kind: "text", text: "\n" });
    para.forEach((node) => {
      if (node.isText) {
        flat.push({ kind: "text", text: node.text ?? "" });
      } else if (node.type.name === "image") {
        flat.push({
          kind: "image",
          assetId: node.attrs.assetId,
          silent: node.attrs.silent,
          name: node.attrs.name ?? "",
        });
      } else if (node.type.name === "keyword") {
        flat.push({ kind: "keyword", title: node.attrs.title });
      }
    });
  });
  return flat;
}

export interface Serialized {
  finalPrompt: string;
  references: PromptedAsset[];
}

/**
 * 序列化 doc → { finalPrompt, references }。
 * 逻辑与旧版 serializePrompt 完全一致（currentImageId / nextSectionTitle / serializeKeyword），
 * 只是数据源从 tokens[] 换成 doc 扁平序列。draft 恒为 ""（所有内容已在 doc 里）。
 */
export function serializeDoc(
  doc: PmNode,
  assetById: Map<string, PromptedAsset>,
  opts: { unfold?: boolean } = {}
): Serialized {
  // unfold=true（默认）= 发 provider 的铺开 prompt（维度展开 body）；false = 原始编辑框文本
  // （维度只出【title】，不铺开 body），存 generation_meta.prompt_raw 供复用还原 chip。
  const unfold = opts.unfold ?? true;
  const flat = docToInline(doc);
  let out = "";
  let currentImageId: string | null = null;
  for (let i = 0; i < flat.length; i++) {
    const n = flat[i];
    if (n.kind === "text") {
      out += n.text;
      continue;
    }
    if (n.kind === "image") {
      if (n.silent) continue; // 还原的参考图：正文已含，不重复输出 @图名（references 仍收集）
      currentImageId = n.assetId;
      const section = nextSectionTitle(flat, i);
      if (section) {
        out += serializeImageToken(n, section.title, assetById, unfold);
        i += section.consumed; // 跳过被图片吞掉的 keyword（及中间的「的」），避免再被 serializeKeyword 重复输出
      } else {
        out += serializeImageToken(n, null, assetById, unfold);
      }
      continue;
    }
    // 独立 keyword（未被图片吞掉的后续维度）：按「最近一张图」展开片段
    out += serializeKeyword(n.title, currentImageId, assetById, unfold);
  }
  // references：所有 image（含 silent）按 assetId 去重
  const references: PromptedAsset[] = [];
  const seen = new Set<string>();
  for (const n of flat) {
    if (n.kind !== "image") continue;
    const a = assetById.get(n.assetId);
    if (a && seen.add(a.id)) references.push(a);
  }
  return { finalPrompt: out.trim(), references };
}

// 发送 prompt 时取最新维度正文：走 assetById（PromptedAsset.sections），而非 keyword 节点 attrs.body
// （后者只是插入时的展示快照，反推更新后不会回写到已插入的 chip）。保证生成用的始终是最新反推内容。
function serializeKeyword(
  title: string,
  currentImageId: string | null,
  assetById: Map<string, PromptedAsset>,
  unfold: boolean = true
) {
  if (!currentImageId || !unfold) return `【${title}】`;
  const fragment = assetById
    .get(currentImageId)
    ?.sections?.find((s) => s.title === title)?.body.trim();
  return fragment ? `【${title}】：${fragment}` : `【${title}】`;
}

/** 紧随图片的维度关键词（可能中间隔一个「的」），返回其标题与吞掉的元素数。 */
function nextSectionTitle(
  flat: Inline[],
  imageIndex: number
): { title: string; consumed: number } | null {
  const next = flat[imageIndex + 1];
  if (next?.kind === "keyword") {
    return { title: next.title, consumed: 1 };
  }
  if (next?.kind === "text" && next.text.trim() === "的") {
    const after = flat[imageIndex + 2];
    if (after?.kind === "keyword") {
      return { title: after.title, consumed: 2 };
    }
  }
  return null;
}

function serializeImageToken(
  node: Extract<Inline, { kind: "image" }>,
  sectionTitle: string | null,
  assetById: Map<string, PromptedAsset>,
  unfold: boolean = true
) {
  const a = assetById.get(node.assetId);
  // 优先用 assetById 最新名，查不到回退 attrs 快照 name（doc 自描述）
  const name = a ? `${a.name}${a.ext ? `.${a.ext}` : ""}` : node.name || node.assetId;

  if (sectionTitle) {
    // unfold=false（原始编辑框文本）：维度不铺开 body，只出 @图名 的【维度】
    if (!unfold) return `@${name} 的【${sectionTitle}】`;
    const caption = a?.caption?.trim();
    const fragment =
      a?.sections?.find((s) => s.title === sectionTitle)?.body.trim() || caption;
    return fragment
      ? `@${name} 的【${sectionTitle}】：${fragment}`
      : `@${name} 的【${sectionTitle}】`;
  }
  // 不选维度 = 纯参考引用：只输出 @图名（图本身已通过 reference_images 传给 codex）
  return `@${name}`;
}

/** 节点图源节点：一张参考图 + 它被选用的维度列表（维度为空 = 整图参考）。 */
export interface GraphSource {
  asset: PromptedAsset;
  dimensions: string[];
}

/**
 * 从 doc 提取节点图数据：每个 image 一个源节点，紧跟其后的 keyword 归为该图的维度。
 * 与官网 graphSourcesFromDoc 同构，但桌面端 keyword 节点无 assetId attr，靠「最近 image」
 * currentImageId 关联（与 serializeDoc 的关联逻辑一致）。silent 参考图（reuse 复用）也作为
 * 源节点显示（整图参考），但不更新 currentImageId、不接收后续维度（其维度已内化在正文里）。
 */
export function graphSourcesFromDoc(
  doc: PmNode,
  assetById: Map<string, PromptedAsset>
): GraphSource[] {
  const sources = new Map<string, GraphSource>();
  const order: string[] = [];
  const ensure = (assetId: string): GraphSource | null => {
    const asset = assetById.get(assetId);
    if (!asset) return null;
    if (!sources.has(assetId)) {
      sources.set(assetId, { asset, dimensions: [] });
      order.push(assetId);
    }
    return sources.get(assetId)!;
  };

  let currentImageId: string | null = null;
  doc.forEach((para) => {
    para.forEach((node) => {
      if (node.type.name === "image") {
        const assetId: string = node.attrs.assetId;
        if (!node.attrs.silent) currentImageId = assetId;
        ensure(assetId);
      } else if (node.type.name === "keyword") {
        if (currentImageId) {
          const s = ensure(currentImageId);
          const title: string = node.attrs.title;
          if (s && !s.dimensions.includes(title)) s.dimensions.push(title);
        }
      }
    });
  });
  return order.map((id) => sources.get(id)!);
}

/** Agent 模式保留 image→keyword 结构，让模型按参考图已选维度理解职责。 */
export function agentPromptReferencesFromDoc(
  doc: PmNode,
  assetById: Map<string, PromptedAsset>
): AgentPromptInput["references"] {
  return graphSourcesFromDoc(doc, assetById).map(({ asset, dimensions }) => ({
    assetId: asset.id,
    name: `${asset.name}${asset.ext ? `.${asset.ext}` : ""}`,
    dimensions: dimensions.map((label) => ({
      key: label,
      label,
      raw:
        asset.sections?.find((section) => section.title === label)?.body.trim() ||
        asset.dimensions?.[label]?.trim() ||
        asset.caption?.trim() ||
        "",
    })),
  }));
}
