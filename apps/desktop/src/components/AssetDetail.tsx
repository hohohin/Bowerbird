import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import { useStore } from "../store";
import { understandProvider } from "../lib/entitlement";
import { api } from "../lib/api";
import { useImageZoom } from "../lib/useImageZoom";
import { RenameDialog } from "./RenameDialog";
import type { Analysis, Asset, AssetTag, CodexHealth, Folder } from "../lib/types";
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
  const runDescribe = useStore((s) => s.runDescribe);
  const cancelDescribe = useStore((s) => s.cancelDescribe);
  const describeStartedAt = useStore((s) => s.describeStartedAt);
  const folders = useStore((s) => s.folders);
  const reloadFolders = useStore((s) => s.reloadFolders);
  const viewGenerationHistory = useStore((s) => s.viewGenerationHistory);
  const generating = useStore((s) => s.generating);
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
  const timerRef = useRef<number | null>(null);

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
    } catch (e) {
      console.error(e);
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
    } catch (e) {
      console.error(e);
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
    } catch (e) {
      console.error(e);
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
    } catch (e) {
      console.error(e);
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
    } catch (e) {
      console.error(e);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
  useEffect(() => {
    const caps = analyses.filter((a) => a.kind === "caption");
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

  function handleDescribe() {
    if (!id) return;
    const instruction = describePrompt.trim();
    if (!instruction) return;
    setErr(null);
    rememberDescribePrompt(instruction);
    // 入全局队列（fire-and-forget）；执行状态走 store，本组件不再 await。
    // 跑完落地后由 analyses://changed 监听器自动 loadAnalyses。
    runDescribe(id, instruction);
  }

  async function deleteCaption(anId: string) {
    try {
      await api.deleteAnalysis(anId);
      await loadAnalyses();
    } catch (e) {
      console.error(e);
      setErr(typeof e === "string" ? e : JSON.stringify(e));
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

  if (!asset || !id) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        资产不存在
      </div>
    );
  }
  const colors = parseColors(asset.colors);
  const captions = analyses.filter((a) => a.kind === "caption");
  // 生成图来源（codex_create_image 落的 generation_meta）：prompt / session_id / 参考图。
  const genMeta = useMemo(() => {
    const row = analyses.find((a) => a.kind === "generation_meta");
    if (!row) return null;
    try {
      const v = JSON.parse(row.payload);
      return {
        prompt: typeof v.prompt === "string" ? v.prompt : undefined,
        session_id: typeof v.session_id === "string" ? v.session_id : undefined,
        references:
          Array.isArray(v.references) ? v.references.filter((x: unknown): x is string => typeof x === "string") : undefined,
        provider: typeof v.provider === "string" ? v.provider : undefined,
      };
    } catch {
      return null;
    }
  }, [analyses]);
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
    <div className="flex h-full w-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge bg-panel px-3 py-2">
        <button
          onClick={closeDetail}
          className="rounded px-2 py-1 text-sm text-muted hover:bg-panel2 hover:text-ink"
        >
          ← 返回
        </button>
        <div className="truncate text-sm font-medium">
          {asset.name}
          {asset.ext ? `.${asset.ext}` : ""}
        </div>
        <button
          onClick={() => setRenameOpen(true)}
          disabled={!asset.store_path}
          className="shrink-0 rounded px-1.5 text-xs text-muted hover:bg-panel2 hover:text-ink disabled:opacity-40"
          title={asset.store_path ? "重命名（同步改磁盘文件名）" : "该素材没有本地文件，无法重命名"}
        >
          ✎
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
          onClick={() => setCollectionPanelOpen((v) => !v)}
          className={`ml-auto rounded px-2 py-1 text-sm hover:bg-panel2 ${
            assetCollections.length > 0 ? "text-accent" : "text-muted hover:text-ink"
          }`}
          title={
            assetCollections.length > 0
              ? `已收藏到 ${assetCollections.length} 个收藏夹`
              : "收藏"
          }
        >
          {assetCollections.length > 0 ? "★" : "☆"} 收藏
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden bg-canvas">
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
                ◀
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
                ▶
              </button>
            </div>
          )}
        </div>

        <aside className="w-96 shrink-0 space-y-4 overflow-y-auto border-l border-edge bg-panel p-3">
          {collectionPanelOpen && (
            <div className="space-y-2 rounded bg-panel2 p-2 text-xs">
              <div className="flex items-center justify-between">
                <div className="font-medium uppercase tracking-wide text-accent">收藏到</div>
                <button
                  onClick={() => setCollectionPanelOpen(false)}
                  className="text-muted hover:text-ink"
                  title="关闭"
                >
                  ✕
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

          <div className="space-y-1.5">
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

          {/* 类别（P2 自动归类 + 手动）：codex 归的为 auto（灰），用户加的为 manual（强调）。 */}
          <div className="space-y-2">
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

          {/* ✨ 生成来源：codex_create_image 落的 generation_meta（prompt / 参考图 / 会话）。 */}
          {genMeta && (
            <div className="space-y-2 rounded bg-panel2 p-2 text-xs text-ink">
              <div className="text-xs font-medium uppercase tracking-wide text-accent">
                ✨ 生成来源
              </div>
              {genMeta.prompt && (
                <div className="whitespace-pre-wrap rounded bg-panel p-1.5 text-[11px]">
                  {genMeta.prompt}
                </div>
              )}
              {genMeta.references && genMeta.references.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] text-muted">
                    参考图（{genMeta.references.length}）
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {genMeta.references.map((p: string) => (
                      <img
                        key={p}
                        src={convertFileSrc(p)}
                        className="h-12 rounded border border-edge object-cover"
                        alt=""
                      />
                    ))}
                  </div>
                </div>
              )}
              {genMeta.session_id && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => viewGenerationHistory(asset.id)}
                    disabled={generating}
                    className="rounded bg-accent px-2 py-1 text-[11px] font-semibold text-black disabled:opacity-50"
                    title="像回看对话一样，看这张图生成时的各轮 prompt 与产出图，并可继续提修改意见"
                  >
                    💬 回看生成对话
                  </button>
                  {genMeta.provider === "codex" && (
                    <button
                      onClick={() =>
                        api.openCodexSession(genMeta.session_id!).catch(console.error)
                      }
                      className="text-[10px] text-accent hover:underline"
                      title="在 Terminal 里 codex resume，看这次生成的完整对话含图"
                    >
                      在 codex 中打开会话 ↗
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 反推：免费档走 Cloud，Pro/Studio 走本机 CLI；当前路由不可用时置灰。 */}
          <div className="space-y-2">
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
                <div className="flex items-center justify-between text-[10px] text-muted">
                  <span>编辑后直接「反推」即用本次内容；「保存为默认」才作为下次默认指令。</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => saveDescribePrompt(describePrompt.trim())}
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
                        caption.sections.map((section, sidx) => (
                          <div
                            key={`${a.id}-${sidx}`}
                            className="rounded bg-panel px-2 py-1"
                          >
                            <div className="mb-0.5 text-[10px] font-medium text-accent">
                              {section.title}
                            </div>
                            <div className="whitespace-pre-wrap text-[11px] text-ink">
                              {section.body}
                            </div>
                          </div>
                        ))
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
                            onClick={() =>
                              api
                                .openCodexSession(caption.sessionId!)
                                .catch(console.error)
                            }
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

          <div className="space-y-1.5">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">
              来源
            </div>
            {asset.source_url ? (
              <button
                onClick={() => open(asset.source_url!)}
                className="block w-full truncate rounded bg-panel2 px-2 py-1.5 text-left text-xs text-accent hover:underline"
                title={asset.source_url}
              >
                打开来源网页 ↗
              </button>
            ) : (
              <div className="text-xs text-muted">无来源链接</div>
            )}
            {asset.origin_path && (
              <Meta label="本地来源" value={asset.origin_path} />
            )}
          </div>
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
