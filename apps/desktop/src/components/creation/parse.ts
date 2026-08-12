import type { Node as PmNode, Schema } from "prosemirror-model";
import type { PromptedAsset } from "../../lib/types";
import { creationSchema, imageAttrs } from "./schema";

/** @ 后名字的合法边界（名字必须完整结束于此）：空白、括号、标点、@ 自身。 */
function isBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return /[\s【】@.,;:!?()[\]，。；：！？（）]/.test(ch);
}

/**
 * 由 assetById 建名→asset 索引：每个 asset 注册「name.ext」与「name」两键。
 * 用于把文本里的 @图名 解析回 asset。
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
          const sectionBody =
            currentAsset?.sections?.find((s) => s.title === title)?.body?.trim() ?? "";
          let consumed = end + 1;
          // 序列化输出「【title】：fragment」（fragment = sectionBody）；文本与之精确匹配则吃掉，
          // chip 后不残留正文；不匹配（sections 与文本不同步）只吃「：」，正文留纯文本。
          if (text[consumed] === "：" || text[consumed] === ":") {
            const after = consumed + 1;
            if (sectionBody && text.slice(after, after + sectionBody.length) === sectionBody) {
              consumed = after + sectionBody.length;
            } else {
              consumed = after;
            }
          }
          out.push(schema.nodes.keyword.create({ title, body: sectionBody }));
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
  // refs 只补充 assetById 没有的图，不覆盖——保留 assetById 里已反推图的 sections
  // （载入【维度】时按 sections 精确匹配 fragment，见 parsePromptToInline）。
  const fullMap = new Map(assetById);
  for (const r of refs) {
    if (!fullMap.has(r.id)) fullMap.set(r.id, r);
  }
  const assetByName = buildAssetByName(fullMap);

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
    if (!referencedIds.has(r.id) && seen.add(r.id)) {
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
