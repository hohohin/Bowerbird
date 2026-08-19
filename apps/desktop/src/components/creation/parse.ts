import type { Node as PmNode, Schema } from "prosemirror-model";
import type { PromptedAsset } from "../../lib/types";
import { creationSchema, imageAttrs } from "./schema";

/** @ 后名字的合法边界（名字必须完整结束于此）：空白、括号、标点、@ 自身。 */
function isBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return /[\s【】@.,;:!?()[\]，。；：！？（）]/.test(ch);
}

/**
 * 「【title】：正文」与前导图（或无前导图）的正文不符时，按 title + 正文前缀全等回绑源图：
 * 图 chip 被删的借用维度经 prompt_raw round-trip 后无 @图 可依，靠正文全等找回资产。
 * 只认正文全等，多资产同文取先注册者；匹配不中返回 null（调用方维持旧行为，正文留纯文本）。
 */
function findSectionOwner(
  title: string,
  textAfter: string,
  assetByName: Map<string, PromptedAsset>
): { asset: PromptedAsset; body: string } | null {
  const seen = new Set<PromptedAsset>();
  for (const a of assetByName.values()) {
    if (seen.has(a)) continue;
    seen.add(a);
    const body = a.sections?.find((s) => s.title === title)?.body?.trim();
    if (body && textAfter.startsWith(body)) return { asset: a, body };
  }
  return null;
}

/**
 * 由 assetById 建名→asset 索引：每个 asset 注册「name.ext」与「name」两键。
 * 用于把文本里的 @图名 解析回 asset（重名不消歧，后写覆盖——手输 @ 只能按名取一）。
 */
export function buildAssetByName(
  assetById: Map<string, PromptedAsset>
): Map<string, PromptedAsset> {
  const m = new Map<string, PromptedAsset>();
  for (const a of assetById.values()) {
    if (!a.name) continue;
    const withExt = `${a.name}${a.ext ? `.${a.ext}` : ""}`;
    m.set(withExt, a);
    if (a.name !== withExt) m.set(a.name, a);
  }
  return m;
}

/** 图片扩展名尾部（与 schema.ts chipName 的 TAIL_IMG_EXT 同规则）。 */
const TAIL_EXT = /\.[A-Za-z0-9]{1,5}$/;

/**
 * 参考图 @标签分配：重名（含「name 自带后缀」与「name.ext」交叉碰撞）时第 2+ 张在扩展名前
 * 插 #k（海报.jpg → 海报#2.jpg），保证标签 ↔ asset 一一对应——同名参考图不再产出相同 @标签
 * （模型绑错图 / 会话详情缩略图错绑的根因）。serialize（发送）与 parse（还原）必须用同一
 * 顺序（references = doc 序去重）调用，round-trip 绑定才一致。返回：
 * - byKey：全部可匹配键（标签 + 去扩展名变体）→ asset，供 parsePromptToInline 贪心匹配；
 * - labelByAsset：assetId → 发送用标签，供 serialize 输出 @标签。
 */
export function assignUniqueLabels(assets: PromptedAsset[]): {
  byKey: Map<string, PromptedAsset>;
  labelByAsset: Map<string, string>;
} {
  const byKey = new Map<string, PromptedAsset>();
  const labelByAsset = new Map<string, string>();
  for (const a of assets) {
    if (!a.name) continue;
    const base = `${a.name}${a.ext ? `.${a.ext}` : ""}`;
    let label = base;
    if (byKey.has(base) && byKey.get(base) !== a) {
      const stem = base.replace(TAIL_EXT, "");
      const extTail = base.slice(stem.length);
      for (let k = 2; ; k++) {
        const cand = `${stem}#${k}${extTail}`;
        if (!byKey.has(cand)) {
          label = cand;
          break;
        }
      }
    }
    byKey.set(label, a);
    labelByAsset.set(a.id, label);
    // 去扩展名变体（@名 不带后缀输入的匹配键）：不抢占已注册键
    const stem = label.replace(TAIL_EXT, "");
    if (stem !== label && !byKey.has(stem)) byKey.set(stem, a);
  }
  return { byKey, labelByAsset };
}

/**
 * 把单行文本解析成内联节点序列：遇 @<asset名>（贪心最长 + 边界检查）转 image node，
 * 匹配失败的 @文本 保持纯文本。不含换行（多行由 parsePromptToDoc 分段）。
 */
export function parsePromptToInline(
  text: string,
  assetByName: Map<string, PromptedAsset>,
  schema: Schema = creationSchema
): PmNode[] {
  const names = [...assetByName.keys()].sort((a, b) => b.length - a.length); // 长→短贪心
  const out: PmNode[] = [];
  let buf = "";
  let i = 0;
  // 最近一张 image：维度 chip 无「：正文」尾随时，body 从它的 sections 回退取（hover 浮层用）。
  let currentAsset: PromptedAsset | null = null;
  const flush = () => {
    if (buf) {
      out.push(schema.text(buf));
      buf = "";
    }
  };
  while (i < text.length) {
    if (text[i] === "@") {
      const matched = names.find((n) => {
        if (text.slice(i + 1, i + 1 + n.length) !== n) return false;
        return isBoundary(text[i + 1 + n.length]); // 名字后必须是边界才算完整匹配
      });
      if (matched) {
        flush();
        const a = assetByName.get(matched)!;
        currentAsset = a;
        out.push(schema.nodes.image.create(imageAttrs(a.id, a, false)));
        i += 1 + matched.length;
        // 兜底：序列化输出「@name.ext」，但 asset.ext=null 时 assetByName 只注册 name（不含 .ext），
        // matched=name 后 .ext 会作为纯文本残留 → 若 matched 不以图片后缀结尾，吃掉紧跟的 .ext。
        if (!/\.[A-Za-z0-9]{1,5}$/.test(matched)) {
          const tail = text.slice(i).match(/^(\.[A-Za-z0-9]{1,5})/);
          if (tail) i += tail[1].length;
        }
        continue;
      }
    }
    // 【维度名】[：正文] → keyword chip（还原 serializeImageToken 的「@图名 的【维度】：正文」）。
    // body 从当前 image 的 sections 取（与序列化 serializeKeyword 同源），不靠文本边界吞——
    // 避免把维度 chip 后用户续写的独立文字误并入 body（「多吞后方一个字」）。
    if (text[i] === "【") {
      const end = text.indexOf("】", i + 1);
      if (end !== -1) {
        const title = text.slice(i + 1, end).trim();
        if (title) {
          flush();
          // 源图：前导 @图（currentAsset）优先；assetId 随 chip 持久绑定
          let owner = currentAsset;
          let sectionBody =
            owner?.sections?.find((s) => s.title === title)?.body?.trim() ?? "";
          let consumed = end + 1;
          // 序列化输出「【title】：fragment」（fragment = sectionBody）；文本与之精确匹配则吃掉，
          // chip 后不残留正文；不匹配（sections 与文本不同步 / 图 chip 被删的借用维度 round-trip）
          // 时按「title+正文」前缀全等回绑其他源图，仍不中才只吃「：」（正文留纯文本，内容不丢）。
          if (text[consumed] === "：" || text[consumed] === ":") {
            const after = consumed + 1;
            if (sectionBody && text.startsWith(sectionBody, after)) {
              consumed = after + sectionBody.length;
            } else {
              const hit = findSectionOwner(title, text.slice(after), assetByName);
              if (hit) {
                owner = hit.asset;
                sectionBody = hit.body;
                consumed = after + hit.body.length;
              } else {
                consumed = after;
              }
            }
          }
          out.push(
            schema.nodes.keyword.create({
              title,
              body: sectionBody,
              assetId: owner?.id ?? null,
            })
          );
          i = consumed;
          continue;
        }
      }
    }
    buf += text[i++];
  }
  flush();
  return out;
}

/**
 * 载入（board-load-prompt）专用：把整段 prompt 文本解析成 doc。
 * - 按换行分段，每段一个 paragraph；段内 @图名 转 image chip。
 * - refs 中未被文本引用的 asset → silent image node 追加到最后一段尾（附件区，序列化时跳过 @图名、references 仍收集）。
 */
export function parsePromptToDoc(
  text: string,
  refs: PromptedAsset[],
  assetById: Map<string, PromptedAsset>,
  schema: Schema = creationSchema
): PmNode {
  // 对象取最新：同 id 时 assetById 的对象优先（含最新反推 sections，【维度】按 sections
  // 精确匹配 fragment）；键注册顺序按 refs——文本里的 @标签由 serialize 按 references 序
  // （= refs 序）分配，两侧同序才能绑回正确的图。
  const byId = new Map<string, PromptedAsset>();
  for (const r of refs) byId.set(r.id, r);
  for (const a of assetById.values()) byId.set(a.id, a);
  const ordered = refs.map((r) => byId.get(r.id)!).filter(Boolean);
  const assetByName = assignUniqueLabels(ordered).byKey;
  // 库内其余素材（不在本次 refs 里）只注册空闲键——重名时不得抢占 refs 的标签，
  // 否则 #k 分配错乱会把 @标签绑到非参考图上。
  const refIds = new Set(refs.map((r) => r.id));
  for (const a of assetById.values()) {
    if (refIds.has(a.id) || !a.name) continue;
    const base = `${a.name}${a.ext ? `.${a.ext}` : ""}`;
    if (!assetByName.has(base)) assetByName.set(base, a);
    const stem = base.replace(TAIL_EXT, "");
    if (stem !== base && !assetByName.has(stem)) assetByName.set(stem, a);
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // 先把每行解析成内联节点数组（暂不建 paragraph），方便最后一段合并 silent 参考图
  const paraInline: PmNode[][] = lines.map((line) =>
    parsePromptToInline(line, assetByName, schema)
  );
  if (paraInline.length === 0) paraInline.push([]);
  const referencedIds = new Set<string>();
  for (const inline of paraInline) {
    for (const node of inline) {
      if (node.type === schema.nodes.image) referencedIds.add(node.attrs.assetId);
    }
  }
  // 未被文本引用的 refs → silent image 追加到最后一段尾
  const seen = new Set<string>();
  for (const r of refs) {
    if (!referencedIds.has(r.id) && !seen.has(r.id)) {
      seen.add(r.id);
      paraInline[paraInline.length - 1].push(
        schema.nodes.image.create(imageAttrs(r.id, r, true))
      );
    }
  }
  const paragraphs = paraInline.map((inline) =>
    schema.nodes.paragraph.create(null, inline)
  );
  return schema.topNodeType.create(null, paragraphs);
}
