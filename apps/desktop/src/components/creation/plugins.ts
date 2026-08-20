import type { Command, EditorState } from "prosemirror-state";
import { Plugin } from "prosemirror-state";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { undo, redo, history } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";
import type { CaptionSection, PromptedAsset } from "../../lib/types";
import { imageAttrs } from "./schema";
import { buildAssetByName } from "./parse";

export interface PluginDeps {
  viewRef: { current: EditorView | null };
  assetByIdRef: { current: Map<string, PromptedAsset> };
  chipSectionsRef: { current: CaptionSection[] };
  /** chipSections 的源图（最近呼环 assetId）：手输维度 chip 绑定它，图 chip 被删后序列化仍能展开其正文 */
  chipAssetIdRef: { current: string | null };
}

/**
 * 标点触发的智能匹配（Space / Enter / , . ，。）：
 * ① 光标前末尾形如 @<完整 asset 名>（@ 后到光标连续无空白）→ 替换为 image chip；
 * ② 否则光标前 endsWith 某 chipSection.title → 替换尾部为 keyword chip（保留前缀如「的」）；
 * ③ 都不中 → 返回 false，回退默认（插入标点 / Enter 走 splitBlock）。
 *
 * IME 组合中（view.composing）不拦——中文输入法的空格是选词键。
 * 载入/粘贴的 @图名 不走这里（由 parsePromptToInline / clipboardTextParser 整段解析）。
 */
function smartPunct(punct: string, deps: PluginDeps): Command {
  return (state, dispatch) => {
    const view = deps.viewRef.current;
    if (view?.composing) return false;
    const sel = state.selection;
    if (!sel.empty) return false;
    const $head = sel.$head;
    if (!$head.parent.isTextblock) return false;
    const before = $head.parent.textBetween(0, $head.parentOffset, "\n", "\n");
    const paraStart = $head.start();

    // ① @图名（手输时名字后是光标，after === 完整 asset 名）
    const atIdx = before.lastIndexOf("@");
    if (atIdx >= 0) {
      const after = before.slice(atIdx + 1);
      if (after && !/\s/.test(after)) {
        const asset = buildAssetByName(deps.assetByIdRef.current).get(after);
        if (asset) {
          if (dispatch) {
            const tr = state.tr;
            tr.replaceWith(
              paraStart + atIdx,
              $head.pos,
              state.schema.nodes.image.create(imageAttrs(asset.id, asset, false))
            );
            if (punct !== "Enter") tr.insertText(punct);
            dispatch(tr.scrollIntoView());
          }
          return true;
        }
      }
    }

    // ② 维度 endsWith（body / assetId / sectionId（车牌）一并存入：手输触发时绑定呼环图）
    const m = deps.chipSectionsRef.current.find((s) => before.endsWith(s.title));
    if (m) {
      if (dispatch) {
        const tr = state.tr;
        tr.replaceWith(
          paraStart + before.length - m.title.length,
          $head.pos,
          state.schema.nodes.keyword.create({
            title: m.title,
            body: m.body,
            assetId: deps.chipAssetIdRef.current,
            sectionId: m.id ?? null,
          })
        );
        if (punct !== "Enter") tr.insertText(punct);
        dispatch(tr.scrollIntoView());
      }
      return true;
    }

    return false;
  };
}

export function buildPlugins(deps: PluginDeps) {
  const punctKeys: Record<string, Command> = {
    Space: smartPunct(" ", deps),
    Enter: smartPunct("Enter", deps),
    ",": smartPunct(",", deps),
    ".": smartPunct(".", deps),
    "，": smartPunct("，", deps),
    "。": smartPunct("。", deps),
  };
  return [
    history(),
    keymap({ "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo }),
    keymap(punctKeys),
    keymap(baseKeymap),
    // 空编辑框占位：doc 只剩一个空段落时给 ProseMirror 根打 is-empty class（随每次
    // state 更新重算），CSS 据此显示「描述你的意图，开始创作吧」占位提示。
    new Plugin({
      props: {
        attributes: (state: EditorState): Record<string, string> =>
          state.doc.childCount === 1 &&
          state.doc.firstChild?.isTextblock === true &&
          state.doc.firstChild.content.size === 0
            ? { class: "is-empty" }
            : {},
      },
    }),
  ];
}
