import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Slice, Fragment } from "prosemirror-model";
import type { Node as PmNode, ResolvedPos } from "prosemirror-model";
import { useStore } from "../../store";
import type { Asset, CaptionSection, PromptedAsset } from "../../lib/types";
import { creationSchema, imageAttrs } from "./schema";
import { serializeDoc } from "./serialize";
import { parsePromptToDoc, parsePromptToInline } from "./parse";
import { buildPlugins } from "./plugins";

const PICK_EVENT = "bowerbird://board-asset-picked";
const LOAD_EVENT = "bowerbird://board-load-prompt";

function initialDoc() {
  return creationSchema.topNodeType.create(null, [
    creationSchema.nodes.paragraph.create(null, [creationSchema.text("请参考")]),
  ]);
}

/**
 * 创作板 ProseMirror 编辑器 hook：非受控 EditorView（doc 不进 React state，只持 tick 计数器
 * 触发派生数据重算）。注册 window 事件（点图插入 / 外部载入），暴露 finalPrompt / references /
 * 维度 chips 状态 / insertKeyword 供 UI 外壳消费。
 */
export function useCreationEditor() {
  const promptedAssets = useStore((s) => s.promptedAssets);
  const [extraAssets, setExtraAssets] = useState<PromptedAsset[]>([]);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [tick, setTick] = useState(0);

  const [chipAssetId, setChipAssetId] = useState<string | null>(null);
  const [showKeywordHints, setShowKeywordHints] = useState(false);

  const assetById = useMemo(() => {
    const m = new Map<string, PromptedAsset>();
    for (const a of extraAssets) m.set(a.id, a);
    for (const a of promptedAssets) m.set(a.id, a); // promptedAssets 优先覆盖（含 caption）
    return m;
  }, [promptedAssets, extraAssets]);

  const chipSections: CaptionSection[] = useMemo(() => {
    const asset = chipAssetId ? assetById.get(chipAssetId) : undefined;
    return asset?.sections && asset.sections.length > 0 ? asset.sections : [];
  }, [chipAssetId, assetById]);

  // ref 镜像：plugin handler / window listener 在 useEffect([]) 闭包里，读 ref 拿最新值
  const assetByIdRef = useRef(assetById);
  assetByIdRef.current = assetById;
  const chipSectionsRef = useRef(chipSections);
  chipSectionsRef.current = chipSections;

  useEffect(() => {
    if (!hostRef.current) return;
    const plugins = buildPlugins({ viewRef, assetByIdRef, chipSectionsRef });
    const view = new EditorView(hostRef.current, {
      state: EditorState.create({ doc: initialDoc(), plugins }),
      dispatchTransaction: (tr) => {
        view.updateState(view.state.apply(tr));
        setTick((t) => t + 1);
      },
      clipboardTextParser: (text: string, $context: ResolvedPos) => {
        // 粘贴也走 @图名 解析：按换行分段，每段 parsePromptToInline。单段返回 inline slice
        // （首尾是 text 时开放以融入相邻文字），多段返回 block slice。
        const schema = $context.parent.type.schema;
        const lines = text.replace(/\r\n/g, "\n").split("\n");
        const blocks: PmNode[] = lines.map((line) =>
          schema.nodes.paragraph.create(
            null,
            parsePromptToInline(line, assetByIdRef.current, schema)
          )
        );
        if (blocks.length === 1) {
          const frag = blocks[0].content;
          return new Slice(
            frag,
            frag.firstChild?.isText ? 1 : 0,
            frag.lastChild?.isText ? 1 : 0
          );
        }
        return new Slice(Fragment.from(blocks), 0, 0);
      },
    });
    viewRef.current = view;

    function onPick(e: Event) {
      const assetId = (e as CustomEvent<string>).detail;
      const asset = assetByIdRef.current.get(assetId);
      const v = viewRef.current;
      if (!v) return;
      const node = v.state.schema.nodes.image.create(imageAttrs(assetId, asset, false));
      v.dispatch(v.state.tr.replaceSelectionWith(node).scrollIntoView());
      v.focus();
      setChipAssetId(assetId);
      setShowKeywordHints(true);
    }

    function onLoad(e: Event) {
      const detail = (e as CustomEvent<{ prompt: string; refs: Asset[] }>).detail;
      if (!detail || typeof detail.prompt !== "string") return;
      const body = detail.prompt.trim();
      if (!body) return;
      const refAssets: PromptedAsset[] = (detail.refs ?? []).map((a) => ({ ...a }));
      setExtraAssets(refAssets);
      const fullMap = new Map(assetByIdRef.current);
      for (const r of refAssets) fullMap.set(r.id, r);
      const doc = parsePromptToDoc(body, refAssets, fullMap);
      const v = viewRef.current;
      if (!v) return;
      v.updateState(EditorState.create({ doc, plugins: v.state.plugins }));
      setChipAssetId(null);
      setShowKeywordHints(false);
      setTick((t) => t + 1);
      setTimeout(() => v.focus(), 0);
    }

    window.addEventListener(PICK_EVENT, onPick);
    window.addEventListener(LOAD_EVENT, onLoad);
    return () => {
      window.removeEventListener(PICK_EVENT, onPick);
      window.removeEventListener(LOAD_EVENT, onLoad);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const serialized = useMemo(() => {
    const doc = viewRef.current?.state.doc;
    if (!doc) return { finalPrompt: "", references: [] as PromptedAsset[] };
    return serializeDoc(doc, assetByIdRef.current);
  }, [tick, assetById]);

  const insertKeyword = useCallback((title: string) => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch(
      v.state.tr.replaceSelectionWith(v.state.schema.nodes.keyword.create({ title })).scrollIntoView()
    );
    v.focus();
  }, []);

  const focus = useCallback(() => viewRef.current?.focus(), []);

  return {
    hostRef,
    focus,
    finalPrompt: serialized.finalPrompt,
    references: serialized.references,
    chipAssetId,
    setChipAssetId,
    chipSections,
    showKeywordHints,
    setShowKeywordHints,
    insertKeyword,
  };
}
