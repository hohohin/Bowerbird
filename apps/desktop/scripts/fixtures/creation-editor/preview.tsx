// 创作对话框编辑器最小挂载：只建 ProseMirror 层（creationSchema + buildPlugins），不挂
// React 外壳 / store / api。暴露 window.view 供测试直接驱动插件 props 与合成键盘事件。
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { creationSchema } from "../../../src/components/creation/schema";
import { buildPlugins } from "../../../src/components/creation/plugins";
import "../../../src/styles.css";

const host = document.createElement("div");
document.getElementById("root")!.append(host);
const viewRef: { current: EditorView | null } = { current: null };
const view = new EditorView(host, {
  state: EditorState.create({
    doc: creationSchema.topNodeType.create(null, [
      creationSchema.nodes.paragraph.create(null, [creationSchema.text("你好")]),
    ]),
    plugins: buildPlugins({
      viewRef,
      assetByIdRef: { current: new Map() },
      chipSectionsRef: { current: [] },
      chipAssetIdRef: { current: null },
    }),
  }),
});
viewRef.current = view;
view.focus();
(window as unknown as Record<string, unknown>).view = view;
