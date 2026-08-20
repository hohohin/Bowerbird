import type { Node as PmNode } from "prosemirror-model";
import type { AgentPromptInput, PromptedAsset } from "../../lib/types";
import { assignUniqueLabels } from "./parse";

/**
 * doc 扁平化后的内联节点表示（对应旧版 Token 类型，便于原样移植序列化逻辑）。
 * image 带 name（attrs 快照）作兜底：assetById 查不到时用 attrs.name（doc 自描述）。
 */
type Inline =
  | { kind: "text"; text: string }
  | { kind: "image"; assetId: string; silent?: boolean; name: string }
  | {
      kind: "keyword";
      title: string;
      assetId: string | null;
      sectionId: string | null;
      body: string;
    };

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
        flat.push({
          kind: "keyword",
          title: node.attrs.title,
          assetId: node.attrs.assetId ?? null,
          sectionId: node.attrs.sectionId ?? null,
          body: node.attrs.body ?? "",
        });
      }
    });
  });
  return flat;
}

export interface Serialized {
  finalPrompt: string;
  references: PromptedAsset[];
  /** 借用维度源图（图 chip 被删、只借维度的资产，doc 序去重）：随 GenJob → generation_meta
   *  落库（dimension_sources），复用生成提示词时据此回绑车牌取最新反推内容。 */
  dimensionSources: PromptedAsset[];
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
  // 参考图集合（doc 序按 assetId 去重）与 @标签分配：重名第 2+ 张插 #k（海报.jpg → 海报#2.jpg），
  // 发送文本（finalPrompt / rawPrompt）与还原解析（parsePromptToDoc）共用同一分配——
  // 同名参考图的 @标签不再相同，模型与会话详情缩略图都不会绑错图。
  const references: PromptedAsset[] = [];
  const seen = new Set<string>();
  const chipAssetIds = new Set<string>(); // 正文里还有非 silent image chip 的资产（维度 raw 序列化用）
  for (const n of flat) {
    if (n.kind !== "image") continue;
    if (!n.silent) chipAssetIds.add(n.assetId);
    const a = assetById.get(n.assetId);
    if (a && !seen.has(a.id)) {
      seen.add(a.id);
      references.push(a);
    }
  }
  const labels = assignUniqueLabels(references).labelByAsset;
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
      // 标签优先用消歧后的；asset 不在 assetById（查不到）时回退 attrs 快照 name / assetId
      const label = labels.get(n.assetId) ?? (n.name || n.assetId);
      const section = nextSectionTitle(flat, i);
      // 紧随维度属本图（未绑定 = 旧草稿，或绑定即本图）才吞并成「@图 的【维度】」；
      // 绑定他图的维度是借用——图按纯参考输出，维度走独立分支按其源图展开，不绑错图。
      if (section && (section.assetId === null || section.assetId === n.assetId)) {
        out += serializeImageToken(n.assetId, label, section, assetById, unfold);
        i += section.consumed; // 跳过被图片吞掉的 keyword（及中间的「的」），避免再被 serializeKeyword 重复输出
      } else {
        out += serializeImageToken(n.assetId, label, null, assetById, unfold);
      }
      continue;
    }
    // 独立 keyword（未被图片吞掉的维度）：优先按自身绑定（插入时的源图）展开，
    // 旧草稿无绑定时回退「最近一张图」。图 chip 被删的借用维度也走这里——
    // 只内联其维度正文、不带 @引用，源图不进 references（不作为参考图发送）。
    const owner = n.assetId ?? currentImageId;
    out += serializeKeyword(
      n.title,
      n.body,
      n.sectionId,
      owner,
      owner ? chipAssetIds.has(owner) : false,
      assetById,
      unfold
    );
  }
  // 借用维度源图（绑定资产无正文 chip）：随发送落 generation_meta.dimension_sources，
  // 复用时回绑车牌取最新反推（见 Serialized.dimensionSources）。
  const dimSeen = new Set<string>();
  const dimensionSources: PromptedAsset[] = [];
  for (const n of flat) {
    if (n.kind !== "keyword" || !n.assetId) continue;
    if (chipAssetIds.has(n.assetId) || dimSeen.has(n.assetId)) continue;
    const a = assetById.get(n.assetId);
    if (a) {
      dimSeen.add(n.assetId);
      dimensionSources.push(a);
    }
  }
  return { finalPrompt: out.trim(), references, dimensionSources };
}

/** 车牌优先寻址：sectionId 直接定位 section（title/body 都取当下值，改名/改正文跟随；
 *  owner 资产里找不到时全库扫牌——车牌全局唯一）。无牌 / 未命中回退「源图 + 标题」寻址。 */
function resolveSection(
  owner: string | null,
  sectionId: string | null,
  title: string,
  assetById: Map<string, PromptedAsset>
): { title: string; body: string } | null {
  if (sectionId) {
    const byOwner = owner
      ? assetById.get(owner)?.sections?.find((s) => s.id === sectionId)
      : undefined;
    const hit =
      byOwner ??
      (() => {
        for (const a of assetById.values()) {
          const s = a.sections?.find((x) => x.id === sectionId);
          if (s) return s;
        }
        return undefined;
      })();
    if (hit) return { title: hit.title, body: hit.body.trim() };
  }
  if (!owner) return null;
  const s = assetById.get(owner)?.sections?.find((x) => x.title === title);
  return s ? { title: s.title, body: s.body.trim() } : null;
}

/** 独立维度 chip 的序列化。owner = 源图；chipInDoc = 源图的 image chip 是否还在正文里。 */
function serializeKeyword(
  title: string,
  snapshot: string,
  sectionId: string | null,
  owner: string | null,
  chipInDoc: boolean,
  assetById: Map<string, PromptedAsset>,
  unfold: boolean
): string {
  const bare = `【${title}】`;
  if (!owner) return bare; // 无主（旧草稿孤儿 / 自由维度名）：维持原样
  // raw 模式且源图 chip 还在文中：只出【title】，重载时靠 @图 的位置关联回绑；
  // 源图 chip 已被删（借用维度）：无 @ 可依，正文直接内联，复用 round-trip 不丢内容。
  if (!unfold && chipInDoc) return bare;
  // 车牌 → 源图+标题 → 插入时快照；标题/正文都取解析出的当下值（改名跟随）。
  const hit = resolveSection(owner, sectionId, title, assetById);
  const body = hit?.body || snapshot.trim();
  const outTitle = hit?.title ?? title;
  return body ? `【${outTitle}】：${body}` : `【${title}】`;
}

/** 紧随图片的维度关键词（可能中间隔一个「的」），返回其标题 / 车牌 / 源图绑定与吞掉的元素数。 */
function nextSectionTitle(
  flat: Inline[],
  imageIndex: number
): { title: string; assetId: string | null; sectionId: string | null; consumed: number } | null {
  const next = flat[imageIndex + 1];
  if (next?.kind === "keyword") {
    return { title: next.title, assetId: next.assetId, sectionId: next.sectionId, consumed: 1 };
  }
  if (next?.kind === "text" && next.text.trim() === "的") {
    const after = flat[imageIndex + 2];
    if (after?.kind === "keyword") {
      return {
        title: after.title,
        assetId: after.assetId,
        sectionId: after.sectionId,
        consumed: 2,
      };
    }
  }
  return null;
}

function serializeImageToken(
  assetId: string,
  label: string,
  section: { title: string; sectionId: string | null } | null,
  assetById: Map<string, PromptedAsset>,
  unfold: boolean = true
) {
  const a = assetById.get(assetId);

  if (section) {
    // unfold=false（原始编辑框文本）：维度不铺开 body，只出 @图名 的【维度】
    if (!unfold) return `@${label} 的【${section.title}】`;
    // 车牌优先定位 section（标题改名跟随），未命中回退标题寻址；再缺整段 caption 兜底（约定 10）。
    const hit =
      (section.sectionId
        ? a?.sections?.find((s) => s.id === section.sectionId)
        : undefined) ?? a?.sections?.find((s) => s.title === section.title);
    const caption = a?.caption?.trim();
    const fragment = hit?.body.trim() || caption;
    const title = hit?.title ?? section.title;
    return fragment
      ? `@${label} 的【${title}】：${fragment}`
      : `@${label} 的【${section.title}】`;
  }
  // 不选维度 = 纯参考引用：只输出 @图名（图本身已通过 reference_images 传给 codex）
  return `@${label}`;
}

/** 节点图源节点：一张参考图 + 它被选用的维度列表（维度为空 = 整图参考）。 */
export interface GraphSource {
  asset: PromptedAsset;
  dimensions: string[];
}

/**
 * 从 doc 提取节点图数据：每个 image 一个源节点，keyword 归为其源图的维度——优先按
 * keyword 自身绑定（assetId attr），旧草稿无绑定时回退「最近 image」currentImageId
 * （与 serializeDoc 的关联逻辑一致）。图 chip 被删的借用维度也会为其源图建源节点
 * （Agent 只读文字维度数据，照样拿到内容；源图不进 references、不作为参考图发送）。
 * silent 参考图（reuse 复用）也作为源节点显示（整图参考），但不更新 currentImageId、
 * 不接收后续维度（其维度已内化在正文里）。
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
        const owner: string | null = node.attrs.assetId ?? currentImageId;
        if (owner) {
          const s = ensure(owner);
          const title: string = node.attrs.title;
          if (s && !s.dimensions.includes(title)) s.dimensions.push(title);
        }
      }
    });
  });
  return order.map((id) => sources.get(id)!);
}

/** Agent 模式保留 image→keyword 结构，让模型按参考图已选维度理解职责。
 *  name 与直发同源：重名参考图用 #k 消歧标签，Agent 组稿的 @引用不绑错图。 */
export function agentPromptReferencesFromDoc(
  doc: PmNode,
  assetById: Map<string, PromptedAsset>
): AgentPromptInput["references"] {
  const sources = graphSourcesFromDoc(doc, assetById);
  const { labelByAsset } = assignUniqueLabels(sources.map((s) => s.asset));
  return sources.map(({ asset, dimensions }) => ({
    assetId: asset.id,
    name: labelByAsset.get(asset.id) ?? `${asset.name}${asset.ext ? `.${asset.ext}` : ""}`,
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
