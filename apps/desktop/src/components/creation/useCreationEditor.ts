import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Slice, Fragment } from "prosemirror-model";
import type { Node as PmNode, ResolvedPos } from "prosemirror-model";
import { useStore } from "../../store";
import type { Asset, CaptionSection, PromptedAsset } from "../../lib/types";
import { creationSchema, imageAttrs } from "./schema";
import { agentPromptReferencesFromDoc, graphSourcesFromDoc, serializeDoc } from "./serialize";
import { parsePromptToDoc, parsePromptToInline } from "./parse";
import { buildPlugins } from "./plugins";

const PICK_EVENT = "bowerbird://board-asset-picked";
const LOAD_EVENT = "bowerbird://board-load-prompt";

function initialDoc(empty = false) {
  // 空初始文档（会话底部对话框用）：不预填「请参考」，避免续轮误发送占位文字。
  if (empty) return creationSchema.topNodeType.create(null, [creationSchema.nodes.paragraph.create()]);
  return creationSchema.topNodeType.create(null, [
    creationSchema.nodes.paragraph.create(null, [creationSchema.text("请参考")]),
  ]);
}

// 创作板草稿即时持久化：用户常暂时收起创作板去找素材 / 看详情再回来，其间组件卸载、
// EditorView 销毁。把 doc 序列化进 localStorage（跨会话也保留），重挂载时 nodeFromJSON
// 恢复 —— 保真保留 image/keyword chip（而非展开成纯文本，那样维度 token 会降级）。
const BOARD_DRAFT_KEY = "bowerbird.boardDraft";
type BoardDraft = { doc: unknown; refs: PromptedAsset[] };
function loadDraft(key: string): BoardDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || !Array.isArray(v.refs)) return null;
    return { doc: v.doc, refs: v.refs };
  } catch {
    return null;
  }
}
function saveDraft(key: string, doc: unknown, refs: PromptedAsset[]) {
  try {
    localStorage.setItem(key, JSON.stringify({ doc, refs }));
  } catch {
    // ignore storage errors（quota / 无痕模式）
  }
}

/**
 * 创作板 ProseMirror 编辑器 hook：非受控 EditorView（doc 不进 React state，只持 tick 计数器
 * 触发派生数据重算）。注册 window 事件（点图插入 / 外部载入），暴露 finalPrompt / references /
 * 维度 chips 状态 / insertKeyword 供 UI 外壳消费。
 *
 * opts.draftKey：草稿持久化的 localStorage key。缺省 = 创作板自己的 bowerbird.boardDraft；
 * 传 null = 不持久化（生成会话编辑坞用——会话本身即记录，且不能覆盖创作板草稿）。
 * opts.initialEmpty：true = 初始文档为空（不预填「请参考」），会话底部对话框（续轮）用。
 */
export function useCreationEditor(opts?: { draftKey?: string | null; initialEmpty?: boolean }) {
  const draftKey = opts?.draftKey === undefined ? BOARD_DRAFT_KEY : opts.draftKey;
  const promptedAssets = useStore((s) => s.promptedAssets);
  // boardOpen 时 s.assets = 全部挑图（含未反推）；并入 assetById 让无 caption 图也能插为参考图，
  // 否则 serialize 的 references 收集不到 → 发送时不传 codex，且 chip 只能拿 assetId 兜底显示。
  // promptedAssets 后置覆盖，给有反推的图补 caption/sections（展开维度片段）。
  const allAssets = useStore((s) => s.assets);
  const [extraAssets, setExtraAssets] = useState<PromptedAsset[]>([]);
  const extraAssetsRef = useRef(extraAssets);
  extraAssetsRef.current = extraAssets;

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [tick, setTick] = useState(0);

  const [chipAssetId, setChipAssetId] = useState<string | null>(null);
  const [showKeywordHints, setShowKeywordHints] = useState(false);

  const assetById = useMemo(() => {
    const m = new Map<string, PromptedAsset>();
    for (const a of allAssets) m.set(a.id, a); // boardOpen 时 = 全部挑图（含未反推，无 caption）
    for (const a of extraAssets) m.set(a.id, a);
    for (const a of promptedAssets) m.set(a.id, a); // promptedAssets 优先覆盖（含 caption）
    return m;
  }, [allAssets, promptedAssets, extraAssets]);

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
    // 恢复上次草稿：nodeFromJSON 保真恢复 doc；refs 补进 extraAssets 供序列化匹配。
    const saved = draftKey ? loadDraft(draftKey) : null;
    let startDoc;
    try {
      startDoc = saved ? creationSchema.nodeFromJSON(saved.doc) : initialDoc(opts?.initialEmpty === true);
    } catch {
      startDoc = initialDoc(opts?.initialEmpty === true);
    }
    if (saved && saved.refs.length) setExtraAssets(saved.refs);
    // 去抖保存：编辑频繁，400ms 静止后落盘（避免每次按键都写 localStorage）。
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleSave = () => {
      if (!draftKey) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveDraft(draftKey, view.state.doc.toJSON(), extraAssetsRef.current);
      }, 400);
    };
    const view = new EditorView(hostRef.current, {
      state: EditorState.create({ doc: startDoc, plugins }),
      dispatchTransaction: (tr) => {
        view.updateState(view.state.apply(tr));
        setTick((t) => t + 1);
        scheduleSave();
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
      // 传 assetByIdRef.current（含已反推图的 sections）；parsePromptToDoc 内部按「只补充」并入 refs，
      // 不让 refs（无 sections）覆盖已反推图，以保证【维度】能按 sections 精确匹配 fragment。
      const doc = parsePromptToDoc(body, refAssets, assetByIdRef.current);
      const v = viewRef.current;
      if (!v) return;
      v.updateState(EditorState.create({ doc, plugins: v.state.plugins }));
      setChipAssetId(null);
      setShowKeywordHints(false);
      setTick((t) => t + 1);
      scheduleSave();
      setTimeout(() => v.focus(), 0);
    }

    // 生成成功关闭创作板 / 手动收起 / 切项目 → 卸载。卸载即把当前 doc 落盘
    // （比 400ms 去抖更可靠——刚编辑完就关板时去抖计时器还挂着），重开创作板恢复。
    window.addEventListener(PICK_EVENT, onPick);
    window.addEventListener(LOAD_EVENT, onLoad);
    return () => {
      window.removeEventListener(PICK_EVENT, onPick);
      window.removeEventListener(LOAD_EVENT, onLoad);
      if (saveTimer) clearTimeout(saveTimer);
      if (draftKey) saveDraft(draftKey, view.state.doc.toJSON(), extraAssetsRef.current);
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

  // 未铺开的「原始编辑框文本」（维度只出【title】、不展开 body）：存 generation_meta.prompt_raw，
  // 复用时载入它还原 chip，避免铺开版 round-trip 的 body 残留 / 多吞。
  const rawPrompt = useMemo(() => {
    const doc = viewRef.current?.state.doc;
    if (!doc) return "";
    return serializeDoc(doc, assetByIdRef.current, { unfold: false }).finalPrompt;
  }, [tick, assetById]);

  // 节点图数据：与序列化同源（同一个 doc / assetById），随编辑实时更新。
  const graphSources = useMemo(() => {
    const doc = viewRef.current?.state.doc;
    if (!doc) return [];
    return graphSourcesFromDoc(doc, assetByIdRef.current);
  }, [tick, assetById]);

  const agentPromptReferences = useMemo(() => {
    const doc = viewRef.current?.state.doc;
    if (!doc) return [];
    return agentPromptReferencesFromDoc(doc, assetByIdRef.current);
  }, [tick, assetById]);

  const insertKeyword = useCallback((title: string, body: string = "") => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch(
      v.state.tr.replaceSelectionWith(v.state.schema.nodes.keyword.create({ title, body })).scrollIntoView()
    );
    v.focus();
  }, []);

  const focus = useCallback(() => viewRef.current?.focus(), []);

  return {
    hostRef,
    focus,
    finalPrompt: serialized.finalPrompt,
    rawPrompt,
    references: serialized.references,
    graphSources,
    agentPromptReferences,
    chipAssetId,
    setChipAssetId,
    chipSections,
    showKeywordHints,
    insertKeyword,
  };
}
