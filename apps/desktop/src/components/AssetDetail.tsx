import { type ReactNode, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { useStore } from "../store";
import { api } from "../lib/api";
import { PromptEditor } from "./PromptEditor";
import type { Analysis, Asset } from "../lib/types";

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

function parseCaptionText(payload: string): string {
  try {
    const v = JSON.parse(payload);
    return typeof v?.text === "string" ? v.text : payload;
  } catch {
    return payload;
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

  async function describe() {
    if (!id) return;
    setDescribing(true);
    try {
      await api.describeAsset(id, false);
      await loadAnalyses();
    } catch (e) {
      console.error(e);
    } finally {
      setDescribing(false);
    }
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

          {/* Phase 5 简化：反推（让 codex 描述这张图） */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-wide text-muted">
                拆解 · 描述
              </div>
              <button
                onClick={describe}
                disabled={describing}
                className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-black disabled:opacity-50"
                title="发 codex：请描述这张图片（默认 Mock）"
              >
                {describing ? "反推中…" : "反推"}
              </button>
            </div>
            {captions.length === 0 ? (
              <div className="text-xs text-muted">
                点「反推」让 AI 描述这张图（默认 Mock；真实 claude 看图能力待 Phase 5 spike）
              </div>
            ) : (
              captions.map((a) => (
                <div
                  key={a.id}
                  className="whitespace-pre-wrap rounded bg-panel2 p-2 text-xs text-ink"
                >
                  {parseCaptionText(a.payload)}
                  {a.provider && (
                    <div className="mt-1 text-[10px] text-muted">{a.provider}</div>
                  )}
                </div>
              ))
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
