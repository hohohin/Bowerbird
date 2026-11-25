import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownToLine, Check, Film, Image, RotateCcw, X } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cancelExplorerCapture, clearFinishedExplorerCaptures, isCaptureActive, retryExplorerCapture, retryFailedExplorerCaptures, useExplorerCaptures, type ExplorerCaptureRecord } from "../lib/explorerCaptureHistory";
import { api } from "../lib/api";
import { externalFiles } from "../lib/externalFiles";
import { notifyError } from "../lib/notify";
import type { Asset } from "../lib/types";
import { isVideoAsset } from "../lib/videoGeneration";
import { videoSourceKey } from "../lib/videoSourceKey";
import { useStore } from "../store";
import { LibraryVideoPreview } from "./LibraryVideoPreview";
import { SourceBrowserPopover } from "./SourceBrowserPopover";
import "./ExplorerCaptureHistory.css";

function bytes(value: number) {
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1048576).toFixed(1)} MB`;
}
function status(item: ExplorerCaptureRecord) {
  if (item.phase === "failed" && item.assetId) return "已入库，交付未完成";
  return ({ queued: "排队中", resolving: "正在解析", downloading: "正在下载", merging: "正在合并", saving: "正在保存", delivering: "正在添加到目标", cancelling: "正在取消", succeeded: "已采集", failed: "采集失败", cancelled: "已取消", interrupted: "已中断" })[item.phase];
}
function CaptureThumbnail({ item }: { item: ExplorerCaptureRecord }) {
  const thumbnail = item.thumbnail || item.localThumbnail;
  return <div className="explorer-capture-thumb">{item.mediaKind === "video" ? <Film size={19} aria-hidden /> : <Image size={19} aria-hidden />}
    {thumbnail && <img key={thumbnail} src={/^(https?:|data:|blob:)/.test(thumbnail) ? thumbnail : convertFileSrc(thumbnail)} alt="" onError={event => { event.currentTarget.hidden = true; }} />}</div>;
}
function downloadTotal(item: ExplorerCaptureRecord) {
  return item.totalBytes && item.totalBytes >= item.receivedBytes ? item.totalBytes : undefined;
}
function transferLabel(item: ExplorerCaptureRecord, total: number | undefined) {
  if (!isCaptureActive(item) || item.receivedBytes <= 0) return "";
  return `${bytes(item.receivedBytes)}${total ? ` / ${bytes(total)}` : ""}`;
}
function CaptureStatus({ item, total }: { item: ExplorerCaptureRecord; total: number | undefined }) {
  const transfer = transferLabel(item, total);
  return <div className="explorer-capture-state">{item.phase === "succeeded" && <Check size={12} aria-hidden />}<span>{status(item)}</span>{transfer && <span>{transfer}</span>}</div>;
}
function CaptureProgress({ item, total }: { item: ExplorerCaptureRecord; total: number | undefined }) {
  if (!isCaptureActive(item)) return null;
  return <>
    {!!item.totalSegments && <div className="explorer-capture-transfer">{item.completedSegments ?? 0} / {item.totalSegments} 分片</div>}
    {!!total && <div className="explorer-capture-progress" role="progressbar" aria-label="下载进度" aria-valuemin={0} aria-valuemax={total} aria-valuenow={item.receivedBytes}><i style={{ transform: `scaleX(${Math.min(1, item.receivedBytes / total)})` }} /></div>}
  </>;
}
function CaptureActions({ item, onView }: { item: ExplorerCaptureRecord; onView: (id: string) => void }) {
  return <div className="explorer-capture-row-actions">
    {item.assetId && <button type="button" onClick={() => onView(item.assetId!)}>查看素材</button>}
    {item.phase === "failed" && item.retryable && <button type="button" onClick={() => retryExplorerCapture(item.id)} aria-label="重试" title="重试"><RotateCcw size={15} aria-hidden /></button>}
    {isCaptureActive(item) && !["saving", "delivering", "cancelling"].includes(item.phase) && <button type="button" onClick={() => void cancelExplorerCapture(item.id)} aria-label="取消" title="取消"><X size={15} aria-hidden /></button>}
  </div>;
}
function CaptureRow({ item, onView }: { item: ExplorerCaptureRecord; onView: (id: string) => void }) {
  const name = item.name || item.sourceHost;
  const total = downloadTotal(item);
  return <li className="explorer-capture-row" data-capture-state={item.phase}>
    <CaptureThumbnail item={item} />
    <div className="explorer-capture-copy">
      <div className="explorer-capture-name" title={name}>{name}</div>
      <CaptureStatus item={item} total={total} />
      <CaptureProgress item={item} total={total} />
      {item.error && <div className="explorer-capture-error">{item.error}</div>}
      {item.phase === "interrupted" && <div className="explorer-capture-transfer">请回到网页重新拖入</div>}
    </div>
    <CaptureActions item={item} onView={onView} />
  </li>;
}
export function ExplorerCaptureHistory({ visible = true }: { visible?: boolean }) {
  const records = useExplorerCaptures(state => state.records);
  const active = records.filter(isCaptureActive).length;
  const projectId = useStore(state => state.activeProjectId);
  const [opened, setOpened] = useState(false);
  const [preview, setPreview] = useState<{ asset: Asset; path: string; projectId: string | null }>();
  const button = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const request = useRef(0);
  const close = useCallback(() => { request.current++; setOpened(false); }, []);
  useLayoutEffect(() => {
    setPreview(undefined);
    if (!visible) close();
    return () => { request.current++; };
  }, [visible, projectId, close]);
  async function openCapturedAsset(id: string) {
    const revision = ++request.current;
    const routeRevision = useStore.getState().projectRouteRevision;
    const isCurrent = () => revision === request.current && useStore.getState().projectRouteRevision === routeRevision;
    try {
      const [asset] = await api.getAssetsByIds([id]);
      if (!isCurrent()) return;
      if (!asset) throw new Error("素材已不存在，请检查素材库");
      if (isVideoAsset(asset)) {
        if (!asset.store_path) throw new Error("素材原文件不可用");
        const path = await externalFiles.media(asset.store_path);
        if (!isCurrent()) return;
        close();
        setPreview({ asset, path, projectId });
      } else {
        close();
        button.current?.focus({ preventScroll: true });
        useStore.getState().openDetail(asset.id);
      }
    } catch (error) {
      if (isCurrent()) notifyError(error, "暂时无法打开素材，请在素材库中查看");
    }
  }
  return <>
    <button ref={button} type="button" className={`explorer-capture-trigger${active ? " is-active" : ""}`} onClick={() => opened ? close() : setOpened(true)} title="采集记录" aria-label="采集记录" aria-haspopup="dialog" aria-expanded={opened} aria-controls={opened && visible ? popoverId : undefined}>
      <ArrowDownToLine size={16} aria-hidden />{active > 0 && <span className="explorer-capture-count explore-capture-status" aria-hidden>{active}</span>}
      <span className="sr-only">{active ? `${active} 项正在采集` : ""}</span>
    </button>
    {opened && visible && <SourceBrowserPopover id={popoverId} button={button} title="采集记录" onClose={close} className="explorer-capture-popover">
      <div className="explorer-capture-bulk-actions">
        <button type="button" onClick={clearFinishedExplorerCaptures} disabled={active === records.length}>清空已结束记录</button>
        <button type="button" onClick={retryFailedExplorerCaptures} disabled={!records.some(item => item.phase === "failed" && item.retryable)}>全部重试</button>
      </div>
      {records.length ? <ul className="explorer-capture-list">{records.map(item => <CaptureRow key={item.id} item={item} onView={id => void openCapturedAsset(id)} />)}</ul>
        : <div className="explorer-capture-empty">暂无采集记录</div>}
    </SourceBrowserPopover>}
    {visible && preview?.projectId === projectId && <LibraryVideoPreview
      asset={preview.asset} path={preview.path} projectId={projectId} sourceKey={videoSourceKey(preview.asset)}
      onClose={() => { setPreview(undefined); button.current?.focus({ preventScroll: true }); }}/>
    }
  </>;
}
