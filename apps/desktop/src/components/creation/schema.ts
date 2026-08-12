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
        const display = name || assetId;
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
      attrs: { title: { default: "" } },
      toDOM(node) {
        return [
          "span",
          {
            class: "mx-0.5 underline decoration-accent text-accent underline-offset-4",
            contentEditable: "false",
          },
          `【${node.attrs.title}】`,
        ];
      },
    },
  },
});

/** 由 asset 构造 image 节点 attrs（点图插入 / 载入解析共用）。asset 缺失时用 assetId 兜底。 */
export function imageAttrs(
  assetId: string,
  asset: PromptedAsset | undefined,
  silent: boolean
) {
  return {
    assetId,
    silent,
    name: asset ? `${asset.name}${asset.ext ? `.${asset.ext}` : ""}` : assetId,
    ext: asset?.ext ?? null,
    thumb: asset?.thumb_path ?? null,
  };
}
