import { type ReactNode, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { useStore } from "../store";
import { api } from "../lib/api";
import { PromptEditor } from "./PromptEditor";
import type { Analysis, Asset, CodexHealth } from "../lib/types";

const VIDEO_EXTS = ["mp4", "mov", "webm", "mkv", "avi", "m4v"];
const DEFAULT_DESCRIBE_PROMPT = "请描述这张图片";
const DESCRIBE_PROMPT_KEY = "bowerbird.describePrompt";
const DESCRIBE_PROMPT_HISTORY_KEY = "bowerbird.describePromptHistory";
const MAX_DESCRIBE_PROMPT_HISTORY = 8;

function loadDescribePrompt() {
  try {
    return localStorage.getItem(DESCRIBE_PROMPT_KEY) || DEFAULT_DESCRIBE_PROMPT;
  } catch {
    return DEFAULT_DESCRIBE_PROMPT;
  }
}

function loadDescribePromptHistory() {
  try {
    const v = JSON.parse(
      localStorage.getItem(DESCRIBE_PROMPT_HISTORY_KEY) || "[]"
    );
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveDescribePrompt(prompt: string) {
  try {
    localStorage.setItem(DESCRIBE_PROMPT_KEY, prompt);
  } catch {
    // ignore storage errors
  }
}

function saveDescribePromptHistory(history: string[]) {
  try {
    localStorage.setItem(DESCRIBE_PROMPT_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // ignore storage errors
  }
}

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
  const closeDetail = useStore((s) => s.closeDetail);
  const asset: Asset | undefined = assets.find((a) => a.id === id);

  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [describing, setDescribing] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [describePrompt, setDescribePrompt] = useState(loadDescribePrompt);
  const [describePromptHistory, setDescribePromptHistory] = useState(
    loadDescribePromptHistory
  );
  const [err, setErr] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [codexHealth, setCodexHealth] = useState<CodexHealth | null>(null);
  const timerRef = useRef<number | null>(null);

  async function loadAnalyses() {
    if (!id) return;
    try {
      setAnalyses(await api.listAnalysesByAsset(id));
    } catch (e) {
      console.error(e);
    }
  }
  useEffect(() => {
    loadAnalyses();
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

  // captions 变化（反推成功 / 删除）后，默认只展开最新一条，其余折叠为摘要。
  useEffect(() => {
    const caps = analyses.filter((a) => a.kind === "caption");
    setExpandedIds(caps.length > 0 ? new Set([caps[0].id]) : new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyses]);

  // 卸载时清理已耗时计时器，避免泄漏。
  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearInterval(timerRef.current);
    };
  }, []);

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

  function startTimer() {
    setElapsedMs(0);
    const start = Date.now();
    timerRef.current = window.setInterval(() => setElapsedMs(Date.now() - start), 1000);
  }

  function stopTimer() {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  async function describe() {
    if (!id) return;
    const instruction = describePrompt.trim();
    if (!instruction) return;
    setDescribing(true);
    setErr(null);
    rememberDescribePrompt(instruction);
    startTimer();
    try {
      await api.describeAsset(id, instruction);
      await loadAnalyses();
    } catch (e) {
      const msg = typeof e === "string" ? e : JSON.stringify(e);
      // 「已取消」是用户主动中断，不算错误，静默处理。
      if (!msg.includes("已取消")) {
        setErr(msg);
      }
    } finally {
      stopTimer();
      setElapsedMs(0);
      setDescribing(false);
    }
  }

  async function cancelDescribe() {
    try {
      await api.cancelCodexDescribe();
    } catch (e) {
      console.error(e);
    }
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

  if (!asset || !id) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        资产不存在
      </div>
    );
  }

  const src = asset.store_path ? convertFileSrc(asset.store_path) : "";
  const colors = parseColors(asset.colors);
  const captions = analyses.filter((a) => a.kind === "caption");
  const promptEmpty = describePrompt.trim().length === 0;

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
        {asset.source && (
          <span className="rounded bg-edge px-1.5 py-0.5 text-[10px] uppercase text-muted">
            {asset.source}
          </span>
        )}
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 items-center justify-center overflow-auto bg-canvas p-4">
          {src &&
            (isVideo(asset.ext) ? (
              <video src={src} controls className="max-h-full max-w-full" />
            ) : (
              <img
                src={src}
                alt={asset.name}
                className="max-h-full max-w-full object-contain"
              />
            ))}
        </div>

        <aside className="w-96 shrink-0 space-y-4 overflow-y-auto border-l border-edge bg-panel p-3">
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

          {/* 反推：让 codex CLI 按当前指令描述这张图。codex 不可用时置灰（约定 7）。 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted">
                反推
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setEditingPrompt((v) => !v)}
                  disabled={describing}
                  className="text-xs text-muted hover:text-accent disabled:opacity-50"
                  title="编辑即将发送给 codex 的反推指令"
                >
                  修改指令
                </button>
                {describing && (
                  <>
                    <span className="text-[10px] tabular-nums text-muted">
                      {Math.round(elapsedMs / 1000)}s
                    </span>
                    <button
                      onClick={cancelDescribe}
                      className="rounded border border-edge px-2 py-1 text-xs text-muted hover:text-red-300"
                      title="中断本次 codex 反推"
                    >
                      取消
                    </button>
                  </>
                )}
                <button
                  onClick={describe}
                  disabled={describing || promptEmpty || !codexHealth?.ok}
                  className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-black disabled:opacity-50"
                  title={
                    !codexHealth?.ok
                      ? codexHealth?.reason || "codex 不可用"
                      : "发 codex CLI：按当前反推指令分析这张图片"
                  }
                >
                  {describing ? "反推中…" : "反推"}
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
                      disabled={describing}
                      className="hover:text-accent disabled:opacity-50"
                    >
                      保存为默认
                    </button>
                    <button
                      onClick={() => setDescribePrompt(DEFAULT_DESCRIBE_PROMPT)}
                      disabled={describing}
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
                          disabled={describing}
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
                {codexHealth && !codexHealth.ok
                  ? codexHealth.reason
                  : "点「反推」让 codex 按当前指令分析这张图。"}
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
                        disabled={describing}
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
                        {caption.sessionId && (
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

          <PromptEditor assetId={id} />

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
    </div>
  );
}
