import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { api } from "../lib/api";
import type { CaptionSection, CodexChunk, CodexHealth, PromptedAsset } from "../lib/types";

type Token =
  | { kind: "text"; text: string }
  | { kind: "image"; assetId: string }
  | { kind: "keyword"; text: string };

/** 一轮生成对话：用户输入（首轮 = 编辑器 finalPrompt，后续 = 修改意见）+ 本轮产出图。 */
type Turn = { id: number; prompt: string; images: string[] };

function tokenKey(t: Token, i: number) {
  if (t.kind === "image") return `img-${t.assetId}-${i}`;
  if (t.kind === "keyword") return `kw-${t.text}-${i}`;
  return `txt-${i}`;
}

/**
 * 创作板：真实 prompt 编辑器 + @ 插图引用。
 *
 * 用户正常输入；输入 @ 后创作板变灰、瀑布流高亮，下一次点击瀑布流图片会
 * 在编辑器当前位置插入「缩略图 + 图片名」token。插入图片后显示维度 chips
 * ——chips 取自该图反推出的 sections（有多少属性就有多少维度），点击即可
 * 插入蓝色下划线维度；用户也可手输维度，按空格/回车/标点时自动识别并转 token。
 */
export function CreationBoard() {
  const promptedAssets = useStore((s) => s.promptedAssets);
  const boardPickMode = useStore((s) => s.boardPickMode);
  const toggleBoard = useStore((s) => s.toggleBoard);
  const startPick = useStore((s) => s.startBoardImagePick);
  const cancelPick = useStore((s) => s.cancelBoardImagePick);

  const inputRef = useRef<HTMLInputElement>(null);
  const [tokens, setTokens] = useState<Token[]>([
    { kind: "text", text: "请参考" },
  ]);
  const [draft, setDraft] = useState("");
  const [showKeywordHints, setShowKeywordHints] = useState(false);
  // 维度 chips 作用于「最近插入的那张图」——它的 sections 即下拉选项。
  const [chipAssetId, setChipAssetId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // 生成对话：turns = 各轮（首轮来自编辑器、后续来自修改意见）；sessionId = codex 会话 id，
  // 首轮 Done 后拿到，后续轮带它 codex exec resume 续接同一对话。
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [revise, setRevise] = useState("");
  const turnIdRef = useRef(0);
  const [codexHealth, setCodexHealth] = useState<CodexHealth | null>(null);

  const assetById = useMemo(() => {
    const m = new Map<string, PromptedAsset>();
    for (const a of promptedAssets) m.set(a.id, a);
    return m;
  }, [promptedAssets]);

  // 当前维度 chips = 最近插入图片的 sections（动态）。没有 sections 则回退五大常用维度。
  const chipSections: CaptionSection[] = useMemo(() => {
    const asset = chipAssetId ? assetById.get(chipAssetId) : undefined;
    return asset?.sections && asset.sections.length > 0
      ? asset.sections
      : [];
  }, [chipAssetId, assetById]);

  // 进入创作板时探测 codex 可用性，生成按钮据此置灰（约定 7：离线/无账号降级置灰）。
  useEffect(() => {
    api
      .codexHealth()
      .then(setCodexHealth)
      .catch(() => setCodexHealth({ ok: false, reason: "codex 状态检测失败" }));
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, [tokens.length, boardPickMode]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<CodexChunk>("codex://chunk", (e) => {
      const c = e.payload;
      if (c.kind === "delta") setStreaming((s) => s + c.text);
      else if (c.kind === "done") {
        setStreaming((s) => s + `\n\n—— done · ${c.elapsed_ms}ms via ${c.provider}`);
        if (c.session_id) setSessionId(c.session_id);
        const imgs = c.images ?? [];
        if (imgs.length > 0) {
          // 把本轮产出图追加到 turns 最后一轮（发送时已 push 占位 turn）。
          setTurns((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            return [...prev.slice(0, -1), { ...last, images: [...last.images, ...imgs] }];
          });
        }
      } else if (c.kind === "error") setStreaming((s) => s + `\n[error: ${c.message}]`);
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  // 瀑布流选中图片后，由 MasonryGrid dispatch 此事件。
  useEffect(() => {
    function onPick(e: Event) {
      const assetId = (e as CustomEvent<string>).detail;
      flushDraft();
      // 不自动插「的」：纯参考引用（@B）不该拖个「的」；维度展开时 serializeImageToken
      // 会自带「的」（@A 的【维度】），用户也可自己打。这样「将@B 变为@A 的调性」才写得出来。
      setTokens((ts) => [...ts, { kind: "image", assetId }]);
      setDraft("");
      setChipAssetId(assetId);
      setShowKeywordHints(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
    window.addEventListener("bowerbird://board-asset-picked", onPick);
    return () => window.removeEventListener("bowerbird://board-asset-picked", onPick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flushDraft() {
    setTokens((ts) => (draft ? [...ts, { kind: "text", text: draft }] : ts));
    setDraft("");
  }

  function addKeyword(keyword: string) {
    const before = draft.replace(new RegExp(`${keyword}$`), "");
    setTokens((ts) => [
      ...ts,
      ...(before ? [{ kind: "text" as const, text: before }] : []),
      { kind: "keyword", text: keyword },
    ]);
    setDraft("");
    // 不收起面板：给同一张图连点多个维度（色调→和→构图）时不用重新 @ 选图。
    // 面板只在 新 @ 选图 / ✕ / Escape 时隐藏。
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function onDraftChange(value: string) {
    if (value.includes("@")) {
      const before = value.replace("@", "");
      if (before) setTokens((ts) => [...ts, { kind: "text", text: before }]);
      setDraft("");
      setShowKeywordHints(false);
      startPick();
      return;
    }
    setDraft(value);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape" && showKeywordHints) {
      setShowKeywordHints(false);
      return;
    }
    if (e.key === "Backspace" && !draft && tokens.length > 0) {
      e.preventDefault();
      setTokens((ts) => ts.slice(0, -1));
      return;
    }
    if ([" ", "Enter", "，", ",", "。", "."].includes(e.key)) {
      const trimmed = draft.trim();
      const match = chipSections.find(
        (s) => s.title === trimmed || trimmed.endsWith(s.title)
      );
      if (match) {
        e.preventDefault();
        addKeyword(match.title);
        if (e.key !== "Enter") setTokens((ts) => [...ts, { kind: "text", text: e.key }]);
      }
    }
  }

  const finalPrompt = useMemo(() => serializePrompt(tokens, draft, assetById), [tokens, draft, assetById]);
  const references = useMemo(() => {
    const refs: string[] = [];
    const seen = new Set<string>();
    for (const t of tokens) {
      if (t.kind !== "image") continue;
      const p = assetById.get(t.assetId)?.store_path;
      if (p && seen.add(p)) refs.push(p);
    }
    return refs;
  }, [tokens, assetById]);

  function copy() {
    const text = `# Prompt\n${finalPrompt}\n\n# References (${references.length})\n${references
      .map((r) => `- ${r}`)
      .join("\n")}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function nextTurnId() {
    turnIdRef.current += 1;
    return turnIdRef.current;
  }

  // 首轮 / 新会话：用编辑器 finalPrompt + 参考图发 codex（新会话），重置对话。
  async function sendCodex() {
    if (!codexHealth?.ok || !finalPrompt) return;
    const prompt = finalPrompt;
    const refs = references;
    setSessionId(null);
    setTurns([{ id: nextTurnId(), prompt, images: [] }]);
    setStreaming("");
    setBusy(true);
    try {
      await api.codexCreateImage({ prompt, referenceImages: refs });
    } catch (e) {
      handleGenError(e);
    } finally {
      setBusy(false);
    }
  }

  // 续轮：带 sessionId 走 codex exec resume 续接同一会话，按修改意见让 codex 编辑上一张图。
  async function sendRevise() {
    if (!codexHealth?.ok || !sessionId || !revise.trim()) return;
    const prompt = revise.trim();
    setRevise("");
    setTurns((prev) => [...prev, { id: nextTurnId(), prompt, images: [] }]);
    setStreaming("");
    setBusy(true);
    try {
      await api.codexCreateImage({ prompt, referenceImages: [], sessionId });
    } catch (e) {
      handleGenError(e);
    } finally {
      setBusy(false);
    }
  }

  // 取消 / 出错时若最后一轮没产出图，移除占位 turn，避免空轮留在时间线。
  function handleGenError(e: unknown) {
    const msg = typeof e === "string" ? e : JSON.stringify(e);
    const cancelled = msg.includes("已取消");
    setStreaming((s) => s + (cancelled ? "\n\n—— 已取消" : `\n[error: ${msg}]`));
    setTurns((prev) =>
      prev.length > 0 && prev[prev.length - 1].images.length === 0 ? prev.slice(0, -1) : prev
    );
  }

  return (
    <aside
      className={`flex w-[420px] shrink-0 flex-col border-l border-edge bg-panel transition ${
        boardPickMode ? "opacity-55 grayscale" : ""
      }`}
    >
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">🎬 创作板</span>
          <span className="rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 text-[10px] text-accent">
            @ 参考图输入
          </span>
        </div>
        <button
          onClick={toggleBoard}
          className="rounded px-2 py-0.5 text-muted hover:bg-panel2 hover:text-ink"
          title="收起创作板"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="rounded-lg border border-edge bg-[#13171f] p-3 text-sm leading-8 text-ink">
          <div className="mb-2 text-[11px] text-muted">
            像跟 AI 输入 prompt 一样书写；输入 <span className="rounded bg-panel2 px-1 text-accent">@</span> 选择图片。
          </div>
          <div
            className="min-h-36 cursor-text rounded bg-panel2/40 p-2 outline-none ring-1 ring-edge focus-within:ring-accent"
            onClick={() => inputRef.current?.focus()}
          >
            {tokens.map((t, i) => (
              <TokenView key={tokenKey(t, i)} token={t} asset={t.kind === "image" ? assetById.get(t.assetId) : undefined} />
            ))}
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={boardPickMode}
              placeholder={tokens.length === 0 ? "请输入 prompt，输入 @ 选择图片…" : ""}
              className="min-w-16 bg-transparent text-ink outline-none placeholder:text-muted disabled:cursor-wait"
            />
          </div>

          {showKeywordHints && !boardPickMode && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
              {chipSections.length > 0 ? (
                <>
                  <span>可选维度（来自该图反推）：</span>
                  {chipSections.map((section) => (
                    <button
                      key={section.title}
                      onClick={() => addKeyword(section.title)}
                      className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-accent hover:bg-accent/20"
                    >
                      {section.title}
                    </button>
                  ))}
                </>
              ) : (
                <span>该图没有反推维度片段，可直接输入文字，或先在详情页反推生成维度。</span>
              )}
              <button
                onClick={() => setShowKeywordHints(false)}
                className="ml-auto rounded px-1 text-muted hover:bg-panel2 hover:text-ink"
                title="收起维度面板（Esc）"
              >
                ✕
              </button>
            </div>
          )}

          {boardPickMode && (
            <div className="mt-2 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-xs text-accent">
              已触发 @ 选择图片：请在瀑布流里点一张已反推的图片。
              <button onClick={cancelPick} className="ml-2 underline">
                取消
              </button>
            </div>
          )}
        </div>

        <div className="mt-3">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">
            实际发送 prompt（图片 token 会按所选维度展开为片段）
          </div>
          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-panel2 p-2 text-[11px] text-ink">
            {finalPrompt || "（开始输入 prompt，或用 @ 插入参考图）"}
          </pre>
        </div>
      </div>

      <div className="space-y-2 border-t border-edge p-3">
        {turns.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-wide text-muted">
              生成对话（{turns.length} 轮 · {turns.reduce((n, t) => n + t.images.length, 0)} 图）
            </div>
            {turns.map((t, i) => (
              <div key={t.id} className="space-y-1 rounded bg-panel2/50 p-2">
                <div className="line-clamp-2 text-[11px] text-muted" title={t.prompt}>
                  <span className="text-accent">{i === 0 ? "首版" : `修改 ${i}`}：</span>
                  {t.prompt}
                </div>
                {t.images.length > 0 ? (
                  <div className={`grid gap-1.5 ${t.images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
                    {t.images.map((p) => (
                      <a key={p} href={convertFileSrc(p)} target="_blank" rel="noreferrer" title={p}>
                        <img
                          src={convertFileSrc(p)}
                          alt=""
                          className="w-full rounded border border-edge object-cover"
                        />
                      </a>
                    ))}
                  </div>
                ) : busy && i === turns.length - 1 ? (
                  <div className="text-[10px] text-muted animate-pulse">codex 生成中…</div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {sessionId && (
          <div className="space-y-1">
            <div className="text-[10px] text-muted">提修改意见（续接同一 codex 会话，记得上一张图）</div>
            <div className="flex gap-1.5">
              <input
                value={revise}
                onChange={(e) => setRevise(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendRevise();
                  }
                }}
                disabled={busy}
                placeholder="如：背景改成白天、去掉霓虹、猫换成狗…"
                className="min-w-0 flex-1 rounded bg-panel2 px-2 py-1.5 text-xs text-ink outline-none ring-1 ring-edge focus:ring-accent disabled:opacity-50"
              />
              <button
                onClick={sendRevise}
                disabled={busy || !revise.trim()}
                className="shrink-0 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50"
              >
                继续修改
              </button>
            </div>
          </div>
        )}

        <button
          onClick={copy}
          disabled={!finalPrompt}
          className="w-full rounded-md bg-panel2 px-3 py-1.5 text-xs text-ink hover:bg-edge disabled:opacity-50"
        >
          {copied ? "已复制 ✓" : "复制（prompt + 参考图）"}
        </button>
        <button
          onClick={busy ? () => api.cancelCodexCreate().catch(console.error) : sendCodex}
          disabled={!busy && (!finalPrompt || !codexHealth?.ok)}
          title={
            !codexHealth?.ok
              ? codexHealth?.reason || "codex 不可用"
              : turns.length > 0
                ? "用当前编辑器 prompt 开新会话重新生成（清空上方对话）"
                : "把最终 prompt + 参考图发 codex CLI 生成图像"
          }
          className={`w-full rounded-md px-3 py-2 text-sm font-semibold disabled:opacity-50 ${
            busy ? "border border-edge bg-panel2 text-ink hover:text-red-300" : "bg-accent text-black"
          }`}
        >
          {busy ? "取消生成" : turns.length > 0 ? "重新生成（新会话）" : "✓ 发送 codex 生成"}
        </button>
        <div className="text-[10px] text-muted">
          {codexHealth && !codexHealth.ok
            ? codexHealth.reason
            : "🎨 生成 → 提修改意见续接同一 codex 会话迭代出图。"}
        </div>
        {streaming && (
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-panel2 p-2 text-[11px] text-ink">
            {streaming}
          </pre>
        )}
      </div>
    </aside>
  );
}

function TokenView({ token, asset }: { token: Token; asset?: PromptedAsset }) {
  if (token.kind === "text") return <span>{token.text}</span>;
  if (token.kind === "keyword") {
    return <span className="mx-0.5 underline decoration-accent text-accent underline-offset-4">【{token.text}】</span>;
  }
  const name = asset ? `${asset.name}${asset.ext ? `.${asset.ext}` : ""}` : token.assetId;
  const thumb = asset?.thumb_path;
  return (
    <span className="mx-1 inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 align-middle text-xs text-accent">
      {thumb ? (
        <img src={convertFileSrc(thumb)} alt="" className="h-6 w-8 rounded object-cover" />
      ) : (
        <span className="flex h-6 w-8 items-center justify-center rounded bg-panel2 text-[10px]">IMG</span>
      )}
      <span className="max-w-28 truncate" title={name}>{name}</span>
    </span>
  );
}

function serializePrompt(tokens: Token[], draft: string, assetById: Map<string, PromptedAsset>) {
  let out = "";
  let currentImageId: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "text") {
      out += t.text;
      continue;
    }
    if (t.kind === "image") {
      currentImageId = t.assetId;
      const section = nextSectionTitle(tokens, i);
      if (section) {
        out += serializeImageToken(t, section.title, assetById);
        i += section.consumed;
      } else {
        out += serializeImageToken(t, null, assetById);
      }
      continue;
    }
    // 独立关键词 token（未被图片吞掉的后续维度）：按「最近一张图」的对应 section
    // 展开成片段，这样同一张图的多个维度（光影/类型/氛围…）都能取到各自片段。
    out += serializeKeyword(t.text, currentImageId, assetById);
  }
  out += draft;
  return out.trim();
}

function serializeKeyword(
  title: string,
  currentImageId: string | null,
  assetById: Map<string, PromptedAsset>
) {
  if (!currentImageId) return `【${title}】`;
  const fragment = assetById
    .get(currentImageId)
    ?.sections?.find((s) => s.title === title)?.body.trim();
  return fragment ? `【${title}】：${fragment}` : `【${title}】`;
}

// 找出紧随图片 token 的维度关键词（可能中间隔了一个「的」），返回其标题与吞掉的 token 数。
function nextSectionTitle(
  tokens: Token[],
  imageIndex: number
): { title: string; consumed: number } | null {
  const next = tokens[imageIndex + 1];
  if (next?.kind === "keyword") {
    return { title: next.text, consumed: 1 };
  }

  if (next?.kind === "text" && next.text.trim() === "的") {
    const afterParticle = tokens[imageIndex + 2];
    if (afterParticle?.kind === "keyword") {
      return { title: afterParticle.text, consumed: 2 };
    }
  }

  return null;
}

function serializeImageToken(
  token: Extract<Token, { kind: "image" }>,
  sectionTitle: string | null,
  assetById: Map<string, PromptedAsset>
) {
  const a = assetById.get(token.assetId);
  const name = a ? `${a.name}${a.ext ? `.${a.ext}` : ""}` : token.assetId;
  const caption = a?.caption?.trim();

  if (sectionTitle) {
    // 按标题在该图的 sections 里查正文；查不到就回退整段 caption，避免片段为空。
    const fragment =
      a?.sections?.find((s) => s.title === sectionTitle)?.body.trim() || caption;
    return fragment
      ? `@${name} 的【${sectionTitle}】：${fragment}`
      : `@${name} 的【${sectionTitle}】`;
  }

  // 不选维度 = 纯参考引用：只输出 @图名（图本身已通过 reference_images 传给 codex），
  // 不灌整段 caption，保持灵活（如「将@B 变为@A 的调性」里的 @B）。
  return `@${name}`;
}
