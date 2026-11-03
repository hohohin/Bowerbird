import { useState } from "react";
import { File, Image, Video } from "lucide-react";
import { userErrorMessage } from "../lib/userError";
import { externalFiles } from "../lib/externalFiles";
import { createFilePreviewQueue } from "../lib/filePreviewQueue";
import { useQuickTransferAssets, useQuickTransferThumbnail } from "../lib/quickTransferThumbnails";
import { useMediaVisibility } from "../lib/useMediaVisibility";
import type { QuickTransferFile } from "../lib/quickTransferState";
import type { Asset } from "../lib/types";

type PreviewQueue = ReturnType<typeof createFilePreviewQueue>;

function fileSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fileIcon(name: string) {
  if (/\.(?:jpg|jpeg|png|webp|gif|bmp|tiff?|heic|heif)$/i.test(name)) return Image;
  if (/\.(?:mp4|mov|webm|mkv|avi|m4v)$/i.test(name)) return Video;
  return File;
}

function fileStatus(file: QuickTransferFile, percent: number) {
  switch (file.status) {
    case "complete": return "已入库";
    case "indexing": return "正在入库";
    case "failed": return file.retryable ? "待入库" : "已中断";
    case "receiving": return `${percent}%`;
  }
}

function TransferFailure({ file }: { file: QuickTransferFile }) {
  if (file.status !== "failed") return null;
  return <p className="quick-transfer-file-error">{userErrorMessage(file.error, file.retryable ? "文件已保存，请重试入库。" : "文件接收未完成。")}
    {!file.retryable && <span>请在手机重新发送这个文件。</span>}</p>;
}

function TransferThumbnail({ file, asset, previews }: { file: QuickTransferFile; asset?: Asset; previews: PreviewQueue }) {
  const { ref, visible } = useMediaVisibility<HTMLSpanElement>();
  const { source, onError } = useQuickTransferThumbnail(asset, visible, previews);
  const Icon = fileIcon(file.name);
  return <span ref={ref} className="quick-transfer-thumbnail">
    {source ? <img src={source} alt={`${file.name} 缩略图`} draggable={false} decoding="async" onError={onError} />
      : <Icon size={20} aria-hidden="true" />}
  </span>;
}

function TransferRow({ file, asset, previews, canRetry, retry }: {
  file: QuickTransferFile; asset?: Asset; previews: PreviewQueue; canRetry: boolean; retry: (id: string) => void;
}) {
  const percent = file.size > 0 ? Math.min(100, Math.floor(file.received / file.size * 100)) : 0;
  return <li className="quick-transfer-file" data-status={file.status}>
    <TransferThumbnail file={file} asset={asset} previews={previews} />
    <div className="quick-transfer-file-info">
      <p className="quick-transfer-file-name" title={file.name}>{file.name}</p>
      <p className="quick-transfer-file-meta">{fileSize(file.size)}</p>
      {file.status === "receiving" && <div className="quick-transfer-progress" role="progressbar" aria-label={`${file.name} 接收进度`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></div>}
      <TransferFailure file={file} />
    </div>
    <div className="quick-transfer-file-state">
      <span>{fileStatus(file, percent)}</span>
      {file.status === "failed" && file.retryable && <button type="button" disabled={!canRetry} onClick={() => retry(file.id)}>重试入库</button>}
    </div>
  </li>;
}

export function QuickTransferQueue({ files, active, canRetry, retry }: {
  files: QuickTransferFile[]; active: boolean; canRetry: boolean; retry: (id: string) => void;
}) {
  const assets = useQuickTransferAssets(files);
  const [previews] = useState(() => createFilePreviewQueue(externalFiles.preview));
  const completed = files.filter(file => file.status === "complete").length;
  return <>
    <div className="quick-transfer-queue-heading"><h3>本次接收</h3><span>{files.length ? `${completed} / ${files.length} 已入库` : "0 个文件"}</span></div>
    {files.length ? <ul className="quick-transfer-queue" aria-label="接收队列">{files.map(file =>
      <TransferRow key={file.id} file={file} asset={assets.get(file.assetId ?? "")} previews={previews} canRetry={canRetry} retry={retry} />)}</ul>
      : <p className="quick-transfer-empty">{active ? "等待手机上传" : "本次没有正在接收的文件"}</p>}
  </>;
}
