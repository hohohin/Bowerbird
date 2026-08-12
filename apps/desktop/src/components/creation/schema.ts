import { Schema } from "prosemirror-model";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { PromptedAsset } from "../../lib/types";

/**
 * 创作板 ProseMirror schema。
 *
 * 三种 inline 节点：
 * - text：普通文字
 * - image：原子 inline chip（缩略图 + 图名），attrs 存 assetId + 显示快照（name/ext/thumb）+ silent 标记
 * - keyword：原子 inline chip（蓝色下划线【维度】），attrs.title
 *
 * atom + inline ⇒ Backspace 天然原子删一次一个 chip，text 默认逐字删。
 * attrs 存快照是因为 toDOM 在 ProseMirror 侧渲染、拿不到 React 闭包；序列化时 name 仍以 assetById 最新值为准（attrs.name 仅兜底）。
 */
export const creationSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }],
    },
    text: { group: "inline" },
    image: {
      inline: true,
      atom: true,
      group: "inline",
      draggable: false,
      attrs: {
        assetId: { default: "" },
        silent: { default: false },
        name: { default: "" },
        ext: { default: null },
        thumb: { default: null },
      },
      toDOM(node) {
        const { assetId, silent, name, thumb } = node.attrs;
        // attrs.name 是创建时的快照（持久化进草稿 localStorage），chipName 修复前载入的旧 chip
        // 快照里可能仍带后缀；nodeFromJSON 恢复也不再过 imageAttrs。显示层兜底再剥一次图片后缀。
        const display = (name || assetId).replace(TAIL_IMG_EXT, "");
        const klass = silent
          ? "border-edge bg-panel2 text-muted"
          : "border-accent/40 bg-accent/10 text-accent";
        const children: Array<[string, Record<string, string>, ...unknown[]]> = [];
        if (silent) children.push(["span", { class: "text-[9px]" }, "📎"]);
        children.push(
          thumb
            ? [
                "img",
                { src: convertFileSrc(thumb), alt: "", class: "h-6 w-8 rounded object-cover" },
              ]
            : [
                "span",
                {
                  class:
                    "flex h-6 w-8 items-center justify-center rounded bg-panel2 text-[10px]",
                },
                "IMG",
              ]
        );
        children.push(["span", { class: "max-w-28 truncate" }, display]);
        return [
          "span",
          {
            class: `mx-1 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 align-middle text-xs ${klass}`,
            "data-asset-id": assetId,
            contentEditable: "false",
            title: silent
              ? `参考图：${display}（已含在正文，随发送一并提交）`
              : display,
          },
          ...children,
        ];
      },
    },
    keyword: {
      inline: true,
      atom: true,
      group: "inline",
      draggable: false,
      // body = 该维度被插入时所属素材的反推正文（CaptionSection.body 快照），仅供编辑框 hover 浮层展示。
      // 序列化发送 prompt 时不读它（仍查 assetById 取最新 body，见 serializeKeyword）。
      attrs: { title: { default: "" }, body: { default: "" } },
      toDOM(node) {
        return [
          "span",
          {
            class: "mx-0.5 underline decoration-accent text-accent underline-offset-4",
            contentEditable: "false",
            "data-keyword": "1",
            "data-body": node.attrs.body ?? "",
          },
          `【${node.attrs.title}】`,
        ];
      },
    },
  },
});

/** 由 asset 构造 image 节点 attrs（点图插入 / 载入解析共用）。asset 缺失时用 assetId 兜底。
 *  attrs.name 仅作 chip 显示 → 纯 asset.name（与瀑布流 alt=shown.name 惯例一致，不拼 ext；
 *  后缀是文件格式噪音）。序列化（serializeImageToken）独立按 assetById 拼 name.ext，后端 prompt 不受影响。
 *  防御：部分素材 name 字段本身含文件名后缀（导入时 codex 不可用降级为原文件名），显示时若 name
 *  恰以「.${ext}」结尾则剥掉，保证 chip 永不带后缀。 */
export function imageAttrs(
  assetId: string,
  asset: PromptedAsset | undefined,
  silent: boolean
) {
  return {
    assetId,
    silent,
    name: asset ? chipName(asset) : assetId,
    ext: asset?.ext ?? null,
    thumb: asset?.thumb_path ?? null,
  };
}

/** 显示名：剥掉 asset.name 末尾的文件后缀（name 含文件名后缀的兜底，如导入降级为原文件名）。
 *  匹配末尾「.」+ 1-5 位字母数字（覆盖 jpg/jpeg/png/webp/gif/svg/avif/heic 等所有图片格式，
 *  含大小写；不依赖 ext 字段）。chip / 节点图共用。 */
const TAIL_IMG_EXT = /\.[A-Za-z0-9]{1,5}$/;
export function chipName(asset: PromptedAsset): string {
  return asset.name.replace(TAIL_IMG_EXT, "");
}
