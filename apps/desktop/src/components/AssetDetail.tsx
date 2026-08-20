import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import {
  ArrowLeft,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Copy,
  Edit3,
  ExternalLink,
  Info,
  MessageSquare,
  Sparkles,
  X,
} from "lucide-react";
import { useStore } from "../store";
import { understandProvider } from "../lib/entitlement";
import { api } from "../lib/api";
import { SMART_REFINE_ENABLED } from "../lib/featureFlags";
import { useImageZoom } from "../lib/useImageZoom";
import { notifyError, notifySuccess } from "../lib/notify";
import { RenameDialog } from "./RenameDialog";
import { LocalAgentPanel } from "./LocalAgentPanel";
import { ReadonlyPrompt } from "./creation/ReadonlyPrompt";
import type { Analysis, Asset, AssetTag, CodexHealth, Folder, GenerationHistory } from "../lib/types";
import {
  DEFAULT_DESCRIBE_PROMPT,
  MAX_DESCRIBE_PROMPT_HISTORY,
  loadDescribePrompt,
  loadDescribePromptHistory,
  saveDescribePrompt,
  saveDescribePromptHistory,
} from "../lib/describePrompt";

const VIDEO_EXTS = ["mp4", "mov", "webm", "mkv", "avi", "m4v"];

function isVideo(ext?: string | null) {
  return !!ext && VIDEO_EXTS.includes(ext.toLowerCase());
}

function parseColors(c: string | null | undefined): string[] {
  if (!c) return [];
  try {
    const v = JSON.parse(c);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface CaptionSection {
  title: string;
  body: string;
}

interface CaptionPayload {
  text: string;
  sessionId: string | null;
  instruction: string | null;
  sections: CaptionSection[];
  dimensions: Record<string, string>;
  parseStatus: string | null;
}

function parseCaptionPayload(payload: string): CaptionPayload {
  try {
    const v = JSON.parse(payload);
    const sections: CaptionSection[] = Array.isArray(v?.sections)
      ? v.sections
          .filter(
            (s: unknown): s is CaptionSection =>
              !!s &&
              typeof (s as CaptionSection).title === "string" &&
              typeof (s as CaptionSection).body === "string"
          )
          .map((s: CaptionSection) => ({ title: s.title, body: s.body }))
      : [];
    const dimensions =
      v?.dimensions && typeof v.dimensions === "object" && !Array.isArray(v.dimensions)
        ? Object.fromEntries(
            Object.entries(v.dimensions).filter(
              (entry): entry is [string, string] =>
                typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].trim().length > 0
            )
          )
        : {};
    return {
      text: typeof v?.text === "string" ? v.text : payload,
      sessionId: typeof v?.session_id === "string" && v.session_id ? v.session_id : null,
      instruction: typeof v?.instruction === "string" && v.instruction ? v.instruction : null,
      sections,
      dimensions,
      parseStatus: typeof v?.parse_status === "string" ? v.parse_status : null,
    };
  } catch {
    return {
      text: payload,
      sessionId: null,
      instruction: null,
      sections: [],
      dimensions: {},
      parseStatus: null,
    };
  }
}

function fmtSize(bytes?: number | null) {
  if (!bytes) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(ts?: number | null) {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString();
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="break-all text-right text-ink">{value}</span>
    </div>
  );
}

/**
 * 资产详情页（浏览模式下覆盖主区）：大图 + 元信息 + 反推描述 + 提示词板块 + 来源外链。
 * 大图走 store_path（原图全尺寸）；视频用 <video>；SVG/图片用 <img>。
 */
export function AssetDetail() {
  const id = useStore((s) => s.detailAssetId);
  const assets = useStore((s) => s.assets);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const closeDetail = useStore((s) => s.closeDetail);
  const openDetail = useStore((s) => s.openDetail);
  const openDescribePicker = useStore((s) => s.openDescribePicker);
  const cancelDescribe = useStore((s) => s.cancelDescribe);
  const describeStartedAt = useStore((s) => s.describeStartedAt);
  const folders = useStore((s) => s.folders);
  const reloadFolders = useStore((s) => s.reloadFolders);
  const viewGenerationHistory = useStore((s) => s.viewGenerationHistory);
  const openContextMenu = useStore((s) => s.openContextMenu);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudAvailable = cloudAuth?.cloud_available ?? false;
  // 本图反推状态：正在跑 / 在队列里（位置从 1 起）/ 空闲。
  const describing = useStore((s) => s.describingId === id);
  const queuePosition = useStore((s) => {
    const i = s.describeQueue.findIndex((q) => q.assetId === id);
    return i >= 0 ? i + 1 : 0;
  });
  const queued = queuePosition > 0;
  const [group, setGroup] = useState<Asset[]>([]);
  // 同流程轮播：生成图取整组过程图。sibling 可能被合并出主列表，故从 group 解析后再回退 assets。
  const asset: Asset | undefined = group.find((a) => a.id === id) ?? assets.find((a) => a.id === id);
  // 同流程轮播位置（生成图组内第几张；-1 = 不在组 / 非生成图）。
  const groupPos = asset ? group.findIndex((a) => a.id === asset.id) : -1;

  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [describePrompt, setDescribePrompt] = useState(loadDescribePrompt);
  const [describePromptHistory, setDescribePromptHistory] = useState(
    loadDescribePromptHistory
  );
  const [err, setErr] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // 正在编辑的维度（哪条反推结果的第几个 section）与编辑草稿；null = 无编辑态。
  const [editingSection, setEditingSection] = useState<{ analysisId: string; index: number } | null>(null);
  const [sectionDraft, setSectionDraft] = useState("");
  const [codexHealth, setCodexHealth] = useState<CodexHealth | null>(null);
  const [tags, setTags] = useState<AssetTag[]>([]);
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [assetCollections, setAssetCollections] = useState<Folder[]>([]);
  const [collectionPanelOpen, setCollectionPanelOpen] = useState(false);
  const [targetCollectionId, setTargetCollectionId] = useState("");
  const [creatingCollection, setCreatingCollection] = useState(false);
  const [collectionName, setCollectionName] = useState("");
  const [collectionBusy, setCollectionBusy] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<"create" | "info">("info");
  const [generationSource, setGenerationSource] = useState<GenerationHistory | null>(null);
  const timerRef = useRef<number | null>(null);
  // caption id 集合快照：区分「新增/删除了一条反推」（重置展开态）与「编辑维度触发的重拉」（保持展开）。
  const captionIdsRef = useRef("");

  async function loadAnalyses() {
    if (!id) return;
    try {
      setAnalyses(await api.listAnalysesByAsset(id));
    } catch (e) {
      console.error(e);
    }
  }

  // 类别（P2）：auto=codex 自动归类、manual=用户手加。改后本页 reload + 全局 emit 刷侧栏计数。
  async function loadTags() {
    if (!id) return;
    try {
      setTags(await api.listAssetTags(id));
    } catch (e) {
      console.error(e);
    }
  }

  async function removeTag(t: AssetTag) {
    if (!id) return;
    // 按 source 全量替换：移除该 tag，同 source 的其余保留。
    const keep = tags.filter((x) => x.source === t.source && x.name !== t.name).map((x) => x.name);
    try {
      await api.setAssetTags(id, keep, t.source);
      await loadTags();
      notifySuccess("类别已移除");
    } catch (e) {
      console.error(e);
      notifyError(e, "移除类别失败");
    }
  }

  async function addTag() {
    const n = tagDraft.trim();
    if (!id || !n) return;
    const manuals = tags.filter((x) => x.source === "manual").map((x) => x.name);
    try {
      await api.setAssetTags(id, [...manuals, n], "manual");
      setAddingTag(false);
      setTagDraft("");
      await loadTags();
      notifySuccess("类别已添加");
    } catch (e) {
      console.error(e);
      notifyError(e, "添加类别失败");
    }
  }

  async function loadCollections() {
    if (!id) return;
    try {
      setAssetCollections(await api.listAssetCollections(id));
    } catch (e) {
      console.error(e);
    }
  }

  async function addToCollection(collectionId: string) {
    if (!id || !collectionId) return;
    setCollectionBusy(true);
    try {
      await api.addAssetToCollection(id, collectionId);
      await loadCollections();
      await reloadFolders();
      setTargetCollectionId("");
      setCollectionPanelOpen(false);
      notifySuccess("已收藏素材");
    } catch (e) {
      console.error(e);
      notifyError(e, "收藏失败");
    } finally {
      setCollectionBusy(false);
    }
  }

  async function createAndAddCollection() {
    const name = collectionName.trim();
    if (!id || !name) return;
    setCollectionBusy(true);
    try {
      const collectionId = await api.createCollection(name);
      await api.addAssetToCollection(id, collectionId);
      setCreatingCollection(false);
      setCollectionName("");
      await reloadFolders();
      await loadCollections();
      setCollectionPanelOpen(false);
      notifySuccess("收藏夹已创建，素材已加入");
    } catch (e) {
      console.error(e);
      notifyError(e, "创建收藏夹失败");
    } finally {
      setCollectionBusy(false);
    }
  }

  async function removeFromCollection(collectionId: string) {
    if (!id) return;
    setCollectionBusy(true);
    try {
      await api.removeAssetFromCollection(id, collectionId);
      await loadCollections();
      notifySuccess("已从收藏夹移除");
    } catch (e) {
      console.error(e);
      notifyError(e, "移出收藏夹失败");
    } finally {
      setCollectionBusy(false);
    }
  }
  useEffect(() => {
    loadAnalyses();
    loadTags();
    loadCollections();
    setCollectionPanelOpen(false);
    setTargetCollectionId("");
    setCreatingCollection(false);
    setCollectionName("");
    setDetailTab("info");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    let alive = true;
    setGenerationSource(null);
    if (!id) return;
    api
      .generationHistory(id, currentProjectId)
      .then((history) => {
        if (alive && (history.turns.length > 0 || history.references.length > 0)) {
          setGenerationSource(history);
        }
      })
      .catch(() => {
        // 普通导入素材没有生成历史，详情页保持无来源卡片即可。
      });
    return () => {
      alive = false;
    };
  }, [id, currentProjectId]);

  // 同流程轮播：本图是生成图（或被合并掉的 sibling）时取整组过程图。非生成图置空。
  // sibling 不在主列表 → assets.find 落空 → 仍走 listGenerationGroup 取组。
  // 组已含 id（轮播切 sibling）→ 跳过，免每次切换都 fetch。
  useEffect(() => {
    if (!id) {
      setGroup([]);
      return;
    }
    if (group.some((a) => a.id === id)) return;
    const inList = assets.find((a) => a.id === id);
    if (inList && !inList.generation_session_id) {
      setGroup([]);
      return;
    }
    let alive = true;
    api
      .listGenerationGroup(id, currentProjectId)
      .then((g) => {
        if (alive) setGroup(g);
      })
      .catch((e) => console.error("listGenerationGroup failed", e));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, currentProjectId]);

  // 左右方向键切换过程图（输入框内不拦截，留给光标移动）。
  useEffect(() => {
    if (group.length <= 1 || groupPos < 0) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))
        return;
      if (e.key === "ArrowLeft" && groupPos > 0) {
        e.preventDefault();
        openDetail(group[groupPos - 1].id);
      } else if (e.key === "ArrowRight" && groupPos < group.length - 1) {
        e.preventDefault();
        openDetail(group[groupPos + 1].id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [group, groupPos, openDetail]);

  // 反推后台化：本图在别处（或本页点反推后离开再回来）跑完落地时，
  // 后端 emit analyses://changed；命中本图则自动刷新 analyses。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<{ asset_id: string }>("analyses://changed", (e) => {
      if (e.payload.asset_id === id) loadAnalyses();
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 进入详情页时检测 codex 可用性，反推按钮据此置灰（约定 7：离线/无账号降级置灰）。
  useEffect(() => {
    api
      .codexHealth()
      .then(setCodexHealth)
      .catch(() =>
        setCodexHealth({ ok: false, reason: "codex 状态检测失败" })
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 安装/登录成功后端 emit `codex://health-changed` → 重取，反推按钮置灰态随之刷新
  // （AssetDetail 的 codexHealth 是独立 useState，不走 store，故自己监听；修同步坑）。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen("codex://health-changed", () => {
      api.codexHealth().then(setCodexHealth).catch(() => {});
    }).then((u) => (alive ? (unlisten = u) : u()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // captions 变化（反推成功 / 删除）后，默认只展开最新一条，其余折叠为摘要。
  // 仅在 caption 集合变化（新增/删除）时重置——编辑维度触发的重拉保持当前展开态。
  useEffect(() => {
    const caps = analyses.filter((a) => a.kind === "caption");
    const ids = caps.map((c) => c.id).join(",");
    if (ids === captionIdsRef.current) return;
    captionIdsRef.current = ids;
    setExpandedIds(caps.length > 0 ? new Set([caps[0].id]) : new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyses]);

  // 已耗时计时器：跟随本图 describing 状态。用 store 的 describeStartedAt 作起点，
  // 即使中途离开详情页再回来（组件重挂）仍准确。describing 结束或卸载时清 interval。
  useEffect(() => {
    if (!describing) {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setElapsedMs(0);
      return;
    }
    const start = describeStartedAt ?? Date.now();
    setElapsedMs(Date.now() - start);
    timerRef.current = window.setInterval(
      () => setElapsedMs(Date.now() - start),
      1000
    );
    return () => {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [describing, describeStartedAt]);

  function rememberDescribePrompt(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const next = [
      trimmed,
      ...describePromptHistory.filter((p) => p !== trimmed),
    ].slice(0, MAX_DESCRIBE_PROMPT_HISTORY);
    setDescribePromptHistory(next);
    saveDescribePromptHistory(next);
    saveDescribePrompt(trimmed);
  }

  function handleDescribe(e: React.MouseEvent<HTMLButtonElement>) {
    if (!id) return;
    const instruction = describePrompt.trim();
    if (!instruction) return;
    setErr(null);
    rememberDescribePrompt(instruction);
    // 弹反推引擎选择浮层（Bowerbird Cloud / 本机 codex）；选定后 store 执行入队。
    const r = e.currentTarget.getBoundingClientRect();
    openDescribePicker(
      { kind: "single", assetId: id, instruction },
      { x: r.left, y: r.bottom },
    );
  }

  async function deleteCaption(anId: string) {
    try {
      await api.deleteAnalysis(anId);
      await loadAnalyses();
      notifySuccess("反推结果已删除");
    } catch (e) {
      console.error(e);
      setErr(typeof e === "string" ? e : JSON.stringify(e));
      notifyError(e, "删除反推结果失败");
    }
  }

  async function copyCaption(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notifySuccess("反推结果已复制");
    } catch (e) {
      notifyError(e, "复制失败");
    }
  }

  // 编辑反推维度：保存时整体替换该条反推的 sections；后端重算 text/dimensions 落库并
  // 广播 analyses://changed → 本页重拉展示新内容，创作板发送时也实时取到新 sections。
  function startEditSection(analysisId: string, index: number, body: string) {
    setEditingSection({ analysisId, index });
    setSectionDraft(body);
  }

  async function saveSection(analysisId: string, sections: CaptionSection[], index: number) {
    const body = sectionDraft.trim();
    if (!body) return;
    // 展开保留 s 全字段（含车牌 id）——后端按 id 保号，编辑不换牌、chip 引用不断链。
    const next = sections.map((s, i) => (i === index ? { ...s, body } : s));
    try {
      await api.updateCaptionSections(analysisId, next);
      setEditingSection(null);
      notifySuccess("维度已更新，创作板发送时将使用新内容");
    } catch (e) {
      console.error(e);
      notifyError(e, "保存维度失败");
    }
  }

  async function openSession(sessionId: string) {
    try {
      await api.openCodexSession(sessionId);
      notifySuccess("已在 Terminal 中打开会话");
    } catch (e) {
      console.error(e);
      notifyError(e, "打开 codex 会话失败");
    }
  }

  async function openSource(url: string) {
    try {
      await open(url);
    } catch (e) {
      notifyError(e, "打开来源网页失败");
    }
  }

  function toggleCaption(cid: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
  }

  const src = asset?.store_path ? convertFileSrc(asset.store_path) : undefined;
  const zoom = useImageZoom(src);

  // 注意：下面两个 useMemo 必须在「资产不存在」提前 return 之前——Hook 不能落在条件
  // 分支之后，否则资产短暂为空的一次渲染会让后续渲染 Hook 数量对不上而崩（Rules of Hooks）。
  // 生成图来源（codex_create_image 落的 generation_meta）：prompt / session_id / 参考图。
  const genMeta = useMemo(() => {
    const row = analyses.find((a) => a.kind === "generation_meta");
    if (!row) return null;
    try {
      const v = JSON.parse(row.payload);
      return {
        prompt: typeof v.prompt === "string" ? v.prompt : undefined,
        prompt_raw: typeof v.prompt_raw === "string" ? v.prompt_raw : undefined,
        session_id: typeof v.session_id === "string" ? v.session_id : undefined,
        references:
          Array.isArray(v.references) ? v.references.filter((x: unknown): x is string => typeof x === "string") : undefined,
        provider: typeof v.provider === "string" ? v.provider : undefined,
      };
    } catch {
      return null;
    }
  }, [analyses]);
  const generationReferences = useMemo(() => {
    if (generationSource?.references.length) return generationSource.references;
    if (!genMeta?.references?.length) return [];
    const available = [...group, ...assets];
    return genMeta.references
      .map((path: string) => available.find((candidate) => candidate.store_path === path))
      .filter((candidate: Asset | undefined): candidate is Asset => !!candidate);
  }, [generationSource, genMeta, group, assets]);

  if (!asset || !id) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        资产不存在
      </div>
    );
  }
  const colors = parseColors(asset.colors);
  const captions = analyses.filter((a) => a.kind === "caption");
  const generationPrompt =
    generationSource?.turns[0]?.prompt_raw?.trim() ||
    genMeta?.prompt_raw?.trim() ||
    generationSource?.turns[0]?.prompt?.trim() ||
    genMeta?.prompt?.trim() ||
    "";
  const promptEmpty = describePrompt.trim().length === 0;
  const understandRoute = understandProvider(cloudEntitlement);
  const understandReady = understandRoute === "codex"
    ? !!codexHealth?.ok
    : understandRoute === "bowerbird-cloud"
      ? cloudAvailable && !!cloudAuth?.logged_in
      : false;
  const understandReason = understandRoute === "codex"
    ? codexHealth?.reason || "codex 不可用"
    : !cloudAvailable
      ? "当前版本未配置 Bowerbird Cloud"
      : !cloudAuth?.logged_in
        ? "免费版反推需要先登录 Bowerbird Cloud（每日 10 次）"
        : "当前账号没有可用的理解引擎";
  const understandLabel = understandRoute === "codex" ? "codex CLI" : "Bowerbird Cloud";
  const collections = folders.filter((f) => f.kind === "collection");
  const collectedIds = new Set(assetCollections.map((f) => f.id));
  const availableCollections = collections.filter((f) => !collectedIds.has(f.id));

  return (
    <div className="asset-detail flex h-full w-full flex-col">
      <header className="asset-detail-toolbar">
        <button
          onClick={closeDetail}
          className="asset-detail-back"
        >
          <ArrowLeft size={15} />
          返回
        </button>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-ink">
            {asset.name}
            {asset.ext ? `.${asset.ext}` : ""}
          </div>
          <div className="mt-0.5 text-[10px] uppercase tracking-[0.16em] text-muted">
            Asset workspace
          </div>
        </div>
        <button
          onClick={() => setRenameOpen(true)}
          disabled={!asset.store_path}
          className="asset-detail-icon-button"
          title={asset.store_path ? "重命名（同步改磁盘文件名）" : "该素材没有本地文件，无法重命名"}
          aria-label="重命名素材"
        >
          <Edit3 size={14} />
        </button>
        {(asset.source === "codex" || asset.source === "jimeng" || asset.source === "bowerbird-cloud") ? (
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
            ✨ {asset.source === "jimeng" ? "即梦" : asset.source === "bowerbird-cloud" ? "Cloud" : "codex"} 生成
          </span>
        ) : asset.source ? (
          <span className="rounded bg-edge px-1.5 py-0.5 text-[10px] uppercase text-muted">
            {asset.source}
          </span>
        ) : null}
        <button
          onClick={() => {
            setDetailTab("info");
            setCollectionPanelOpen((v) => !v);
          }}
          className={`asset-detail-collect ml-auto ${
            assetCollections.length > 0 ? "is-active" : ""
          }`}
          title={
            assetCollections.length > 0
              ? `已收藏到 ${assetCollections.length} 个收藏夹`
              : "收藏"
          }
        >
          <Bookmark size={14} fill={assetCollections.length > 0 ? "currentColor" : "none"} />
          {assetCollections.length > 0 ? `已收藏 ${assetCollections.length}` : "收藏"}
        </button>
      </header>
      <div className="hatch-divider is-compact" aria-hidden="true"><span /></div>

      <div className="flex flex-1 overflow-hidden">
        <div className="asset-detail-stage flex flex-1 flex-col overflow-hidden bg-canvas">
          <div className="flex flex-1 items-center justify-center overflow-hidden p-4">
            {src &&
              (isVideo(asset.ext) ? (
                <video src={src} controls className="max-h-full max-w-full" />
              ) : (
                <img
                  ref={zoom.imgRef}
                  src={src}
                  alt={asset.name}
                  draggable={false}
                  onMouseDown={zoom.onMouseDown}
                  onDoubleClick={zoom.onDoubleClick}
                  onContextMenu={(e) => {
                    // 右键打开菜单；preventDefault 让 zoom onMouseDown 不会误平移。
                    e.preventDefault();
                    e.stopPropagation();
                    openContextMenu(e.clientX, e.clientY, asset.id);
                  }}
                  className="max-h-full max-w-full select-none object-contain"
                  style={zoom.style}
                />
              ))}
          </div>
          {/* 过程图轮播：图片下方常驻「◀ 1/2 ▶」+ 左右方向键切换 */}
          {group.length > 1 && groupPos >= 0 && (
            <div className="flex shrink-0 items-center justify-center gap-2 border-t border-edge bg-panel py-1.5 text-muted">
              <button
                onClick={() => openDetail(group[groupPos - 1].id)}
                disabled={groupPos === 0}
                className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-panel2 hover:text-ink disabled:opacity-30"
                title="上一张过程图（←）"
              >
                <ChevronLeft size={15} />
              </button>
              <span className="min-w-[3rem] text-center tabular-nums text-xs">
                {groupPos + 1} / {group.length}
              </span>
              <button
                onClick={() => openDetail(group[groupPos + 1].id)}
                disabled={groupPos === group.length - 1}
                className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-panel2 hover:text-ink disabled:opacity-30"
                title="下一张过程图（→）"
              >
                <ChevronRight size={15} />
              </button>
            </div>
          )}
        </div>

        <aside className="asset-detail-panel">
          <div className="asset-detail-panel-header">
            <div>
              <div className="panel-kicker">Asset intelligence</div>
              <div className="mt-1 text-sm font-semibold text-ink">素材洞察</div>
            </div>
            <div className="asset-detail-tabs" role="tablist" aria-label="详情内容">
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === "info"}
                className={detailTab === "info" ? "is-active" : ""}
                onClick={() => setDetailTab("info")}
              >
                <Info size={13} />
                信息
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === "create"}
                className={detailTab === "create" ? "is-active" : ""}
                onClick={() => setDetailTab("create")}
              >
                <Sparkles size={13} />
                再创作
              </button>
            </div>
          </div>

          {detailTab === "info" && (
            <>
          {collectionPanelOpen && (
            <div className="asset-detail-card space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <div className="font-medium uppercase tracking-wide text-accent">收藏到</div>
                <button
                  onClick={() => setCollectionPanelOpen(false)}
                  className="text-muted hover:text-ink"
                  title="关闭"
                >
                  <X size={13} />
                </button>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {assetCollections.length === 0 ? (
                  <span className="text-muted">尚未收藏到任何收藏夹</span>
                ) : (
                  assetCollections.map((c) => (
                    <span
                      key={c.id}
                      className="flex items-center gap-1 rounded bg-accent/15 px-2 py-0.5 text-[11px] text-accent"
                    >
                      ★ {c.name}
                      <button
                        onClick={() => removeFromCollection(c.id)}
                        disabled={collectionBusy}
                        className="text-[10px] opacity-60 hover:opacity-100 disabled:opacity-30"
                        title="从该收藏夹移除"
                      >
                        ✕
                      </button>
                    </span>
                  ))
                )}
              </div>

              {creatingCollection ? (
                <div className="flex items-center gap-1">
                  <input
                    autoFocus
                    value={collectionName}
                    onChange={(e) => setCollectionName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createAndAddCollection();
                      if (e.key === "Escape") {
                        setCreatingCollection(false);
                        setCollectionName("");
                      }
                    }}
                    placeholder="收藏夹名"
                    className="w-32 rounded bg-panel px-2 py-1 text-xs outline-none ring-1 ring-edge focus:ring-accent"
                  />
                  <button
                    onClick={createAndAddCollection}
                    disabled={collectionBusy || !collectionName.trim()}
                    className="rounded bg-accent px-2 py-1 text-xs text-black disabled:opacity-50"
                  >
                    创建并收藏
                  </button>
                  <button
                    onClick={() => {
                      setCreatingCollection(false);
                      setCollectionName("");
                    }}
                    disabled={collectionBusy}
                    className="text-xs text-muted hover:text-ink"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <select
                    value={targetCollectionId}
                    onChange={(e) => setTargetCollectionId(e.target.value)}
                    disabled={collectionBusy || availableCollections.length === 0}
                    className="min-w-0 flex-1 rounded bg-panel px-1.5 py-1 text-xs outline-none ring-1 ring-edge focus:ring-accent disabled:opacity-50"
                  >
                    <option value="">
                      {availableCollections.length === 0 ? "没有可选收藏夹" : "选择收藏夹"}
                    </option>
                    {availableCollections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => addToCollection(targetCollectionId)}
                    disabled={collectionBusy || !targetCollectionId}
                    className="rounded bg-accent px-2 py-1 text-xs text-black disabled:opacity-50"
                  >
                    确定
                  </button>
                  <button
                    onClick={() => setCreatingCollection(true)}
                    disabled={collectionBusy}
                    className="text-xs text-accent hover:opacity-80 disabled:opacity-50"
                  >
                    + 新建
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="asset-detail-card space-y-1.5">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">
              信息
            </div>
            <Meta
              label="尺寸"
              value={
                asset.width && asset.height
                  ? `${asset.width} × ${asset.height}`
                  : "-"
              }
            />
            <Meta label="大小" value={fmtSize(asset.size)} />
            <Meta label="导入时间" value={fmtTime(asset.created_at)} />
            <Meta label="文件修改" value={fmtTime(asset.file_mtime)} />
            {colors.length > 0 && (
              <div className="flex h-3 w-full overflow-hidden rounded">
                {colors.map((c, i) => (
                  <div key={i} className="flex-1" style={{ background: c }} />
                ))}
              </div>
            )}
          </div>

            </>
          )}

          {detailTab === "create" && (
            <>

          {/* 生成来源：只读还原首次生成时的原始创作板输入，而不是铺开发 provider 的 prompt。 */}
          {genMeta && (
            <div className="asset-detail-card space-y-2 text-xs text-ink">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-medium uppercase tracking-wide text-accent">
                  生成来源
                </div>
                <span className="text-[9px] uppercase tracking-[0.12em] text-muted">只读</span>
              </div>
              {(generationPrompt || generationReferences.length > 0) && (
                <div className="generation-source-editor border border-edge bg-canvas p-2 text-[11px] leading-7">
                  <ReadonlyPrompt prompt={generationPrompt} references={generationReferences} />
                </div>
              )}
              {genMeta.session_id && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => viewGenerationHistory(asset.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
                    title="像回看对话一样，看这张图生成时的各轮 prompt 与产出图，并可继续提修改意见"
                  >
                    <MessageSquare size={13} />
                    回看生成对话
                  </button>
                  {genMeta.provider === "codex" && (
                    <button
                      onClick={() => void openSession(genMeta.session_id!)}
                      className="text-[10px] text-accent hover:underline"
                      title="在 Terminal 里 codex resume，看这次生成的完整对话含图"
                    >
                      在 codex 中打开会话 <ExternalLink size={11} className="inline" />
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 「智能精修」（LocalAgentPanel）：功能未完成，随 SMART_REFINE_ENABLED 隐藏。 */}
          {SMART_REFINE_ENABLED && (
            <LocalAgentPanel
              asset={asset}
              hasCaption={captions.length > 0}
              onAnalyze={() => {
                const instruction = describePrompt.trim();
                if (!id || !instruction) return;
                rememberDescribePrompt(instruction);
                openDescribePicker(
                  { kind: "single", assetId: id, instruction },
                  { x: Math.max(12, window.innerWidth - 420), y: 260 },
                );
              }}
            />
          )}

            </>
          )}

          {detailTab === "info" && (
            <>
          {/* 反推：免费档走 Cloud，Pro/Studio 走本机 CLI；当前路由不可用时置灰。 */}
          <div className="asset-detail-card space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted">
                反推
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setEditingPrompt((v) => !v)}
                  disabled={describing || queued}
                  className="text-xs text-muted hover:text-accent disabled:opacity-50"
                  title="编辑反推指令"
                >
                  修改指令
                </button>
                {(describing || queued) && (
                  <>
                    <span className="text-[10px] tabular-nums text-muted">
                      {describing ? `${Math.round(elapsedMs / 1000)}s` : `排队 ${queuePosition}`}
                    </span>
                    <button
                      onClick={() => cancelDescribe(id)}
                      className="rounded border border-edge px-2 py-1 text-xs text-muted hover:text-red-300"
                      title={describing ? "中断本次反推" : "从队列移除"}
                    >
                      取消
                    </button>
                  </>
                )}
                <button
                  onClick={handleDescribe}
                  disabled={describing || queued || promptEmpty || !understandReady}
                  className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-black disabled:opacity-50"
                  title={
                    !understandReady
                      ? understandReason
                      : `发 ${understandLabel}：按当前反推指令分析这张图片`
                  }
                >
                  {describing ? "反推中…" : queued ? "排队中…" : "反推"}
                </button>
              </div>
            </div>
            {/* 当前指令始终可见（折叠态一行预览，展开态在下方编辑） */}
            {!editingPrompt && (
              <div className="line-clamp-1 text-[10px] text-muted" title={describePrompt}>
                当前指令：{describePrompt}
              </div>
            )}
            {editingPrompt && (
              <div className="space-y-2">
                <textarea
                  value={describePrompt}
                  onChange={(e) => setDescribePrompt(e.target.value)}
                  className="h-24 w-full resize-none rounded bg-panel2 p-2 text-xs text-ink outline-none ring-1 ring-edge focus:ring-accent"
                  placeholder={DEFAULT_DESCRIBE_PROMPT}
                />
                <div className="flex flex-col gap-2 text-[10px] text-muted">
                  <span>编辑后直接「反推」即用本次内容；「保存为默认」才作为下次默认指令。</span>
                  <div className="flex justify-end gap-3">
                    <button
                      onClick={() => {
                        saveDescribePrompt(describePrompt.trim());
                        notifySuccess("已保存为默认反推指令");
                      }}
                      disabled={describing || queued}
                      className="hover:text-accent disabled:opacity-50"
                    >
                      保存为默认
                    </button>
                    <button
                      onClick={() => setDescribePrompt(DEFAULT_DESCRIBE_PROMPT)}
                      disabled={describing || queued}
                      className="hover:text-accent disabled:opacity-50"
                    >
                      恢复默认
                    </button>
                  </div>
                </div>
                {describePromptHistory.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[10px] font-medium uppercase tracking-wide text-muted">
                      历史指令
                    </div>
                    <div className="flex flex-col gap-1">
                      {describePromptHistory.map((p) => (
                        <button
                          key={p}
                          onClick={() => setDescribePrompt(p)}
                          disabled={describing || queued}
                          className="line-clamp-2 rounded bg-panel2 px-2 py-1 text-left text-[10px] text-muted hover:text-accent disabled:opacity-50"
                          title={p}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {err && (
              <div className="whitespace-pre-wrap rounded bg-red-500/15 p-2 text-xs text-red-300">
                {err}
              </div>
            )}
            {captions.length === 0 ? (
              <div className="text-xs text-muted">
                {!understandReady
                  ? understandReason
                  : `点「反推」让 ${understandLabel} 按当前指令分析这张图。`}
              </div>
            ) : (
              captions.map((a) => {
                const caption = parseCaptionPayload(a.payload);
                const hasSections = caption.sections.length > 0;
                const expanded = expandedIds.has(a.id);
                return (
                  <div
                    key={a.id}
                    className="space-y-2 rounded bg-panel2 p-2 text-xs text-ink"
                  >
                    {/* 头部：折叠箭头 + 时间 + 指令摘要（点击切换展开）；右侧删除 */}
                    <div className="flex items-center justify-between gap-2">
                      <button
                        onClick={() => toggleCaption(a.id)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        title={expanded ? "收起" : "展开"}
                      >
                        <span className="text-[9px] text-muted">
                          {expanded ? "▾" : "▸"}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted">
                          {fmtTime(a.created_at)}
                        </span>
                        {caption.instruction && (
                          <span
                            className="truncate text-[10px] text-muted"
                            title={caption.instruction}
                          >
                            {caption.instruction}
                          </span>
                        )}
                      </button>
                      <button
                        onClick={() => void copyCaption(caption.text)}
                        className="shrink-0 text-muted hover:text-accent"
                        title="复制这条反推结果"
                        aria-label="复制反推结果"
                      >
                        <Copy size={12} />
                      </button>
                      <button
                        onClick={() => deleteCaption(a.id)}
                        disabled={describing || queued}
                        className="shrink-0 text-[10px] text-muted hover:text-red-300 disabled:opacity-50"
                        title="删除这条反推结果"
                      >
                        删除
                      </button>
                    </div>
                    {expanded &&
                      (hasSections ? (
                        caption.sections.map((section, sidx) => {
                          const editing =
                            editingSection?.analysisId === a.id && editingSection.index === sidx;
                          return (
                            <div
                              key={`${a.id}-${sidx}`}
                              className="rounded bg-panel px-2 py-1"
                            >
                              <div className="mb-0.5 flex items-center justify-between gap-2">
                                <div className="text-[10px] font-medium text-accent">
                                  {section.title}
                                </div>
                                {!editing && (
                                  <button
                                    onClick={() => startEditSection(a.id, sidx, section.body)}
                                    disabled={describing || queued || !!editingSection}
                                    className="shrink-0 text-muted hover:text-accent disabled:opacity-50"
                                    title="修改这个维度的内容（创作板发送时用新内容）"
                                    aria-label={`修改维度 ${section.title}`}
                                  >
                                    <Edit3 size={11} />
                                  </button>
                                )}
                              </div>
                              {editing ? (
                                <div className="space-y-1.5">
                                  <textarea
                                    autoFocus
                                    value={sectionDraft}
                                    onChange={(e) => setSectionDraft(e.target.value)}
                                    className="h-20 w-full resize-none rounded bg-panel2 p-1.5 text-[11px] text-ink outline-none ring-1 ring-edge focus:ring-accent"
                                  />
                                  <div className="flex justify-end gap-3 text-[10px]">
                                    <button
                                      onClick={() => setEditingSection(null)}
                                      className="text-muted hover:text-accent"
                                    >
                                      取消
                                    </button>
                                    <button
                                      onClick={() => void saveSection(a.id, caption.sections, sidx)}
                                      disabled={!sectionDraft.trim()}
                                      className="text-accent disabled:opacity-50"
                                    >
                                      保存
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="whitespace-pre-wrap text-[11px] text-ink">
                                  {section.body}
                                </div>
                              )}
                            </div>
                          );
                        })
                      ) : (
                        <>
                          <div className="whitespace-pre-wrap">{caption.text}</div>
                          <div className="rounded border border-edge bg-panel px-2 py-1 text-[10px] text-muted">
                            {caption.parseStatus === "raw_fallback"
                              ? "没有按维度分段，可作为整段描述使用，或调整指令后重新反推。"
                              : "这是较早的反推结果（未分段），重新反推可得到分维度描述。"}
                          </div>
                        </>
                      ))}
                    {expanded && (a.provider || caption.sessionId) && (
                      <div className="flex items-center justify-between gap-2 pt-1">
                        {a.provider && (
                          <span className="text-[10px] text-muted">
                            {a.provider}
                          </span>
                        )}
                        {caption.sessionId && a.provider === "codex" && (
                          <button
                            onClick={() => void openSession(caption.sessionId!)}
                            className="text-[10px] text-accent hover:underline"
                            title="在 Terminal 里跑 codex resume，看这次反推的完整对话（含图）"
                          >
                            在 codex 中打开 ↗
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* 类别（P2 自动归类 + 手动）：codex 归的为 auto（灰），用户加的为 manual（强调）。 */}
          <div className="asset-detail-card space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">类别</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {tags.length === 0 && !addingTag && (
                <span className="text-xs text-muted">
                  无（采集后会自动归类，也可手动加）
                </span>
              )}
              {tags.map((t) => (
                <span
                  key={`${t.source}:${t.name}`}
                  className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
                    t.source === "auto" ? "bg-panel2 text-muted" : "bg-accent/15 text-accent"
                  }`}
                  title={t.source === "auto" ? "自动归类（codex）" : "手动添加"}
                >
                  <span className="opacity-50">#</span> {t.name}
                  <button
                    onClick={() => removeTag(t)}
                    className="text-[10px] opacity-60 hover:opacity-100"
                    title="移除"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            {addingTag ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addTag();
                    if (e.key === "Escape") {
                      setAddingTag(false);
                      setTagDraft("");
                    }
                  }}
                  placeholder="新类别名"
                  className="w-32 rounded bg-panel2 px-2 py-1 text-xs outline-none ring-1 ring-edge focus:ring-accent"
                />
                <button
                  onClick={addTag}
                  disabled={!tagDraft.trim()}
                  className="rounded bg-accent px-2 py-1 text-xs text-black disabled:opacity-50"
                >
                  加
                </button>
                <button
                  onClick={() => {
                    setAddingTag(false);
                    setTagDraft("");
                  }}
                  className="text-xs text-muted hover:text-ink"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                onClick={() => setAddingTag(true)}
                className="text-xs text-accent hover:opacity-80"
              >
                + 加类别
              </button>
            )}
          </div>

            </>
          )}

          {detailTab === "info" && (
          <div className="asset-detail-card space-y-1.5">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">
              来源
            </div>
            {asset.source_url ? (
              <button
                onClick={() => void openSource(asset.source_url!)}
                className="block w-full truncate rounded bg-panel2 px-2 py-1.5 text-left text-xs text-accent hover:underline"
                title={asset.source_url}
              >
                打开来源网页 <ExternalLink size={11} className="inline" />
              </button>
            ) : (
              <div className="text-xs text-muted">无来源链接</div>
            )}
            {asset.origin_path && (
              <Meta label="本地来源" value={asset.origin_path} />
            )}
          </div>
          )}
        </aside>
      </div>
      <RenameDialog
        open={renameOpen}
        assetId={asset.id}
        currentName={asset.name}
        onClose={() => setRenameOpen(false)}
      />
    </div>
  );
}
