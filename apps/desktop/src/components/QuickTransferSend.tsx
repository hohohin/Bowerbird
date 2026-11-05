import { File, Plus, X } from "lucide-react";
import type { QuickTransferSnapshot } from "../lib/quickTransferState";
import { quickTransferFileSize } from "../lib/quickTransferState";

export function QuickTransferSend({ sending, paths, disabled, canStart, onPick, onRemove, onStart, onStop }: {
  sending: QuickTransferSnapshot["sending"]; paths: string[]; disabled: boolean; canStart: boolean;
  onPick: () => void; onRemove: (path: string) => void; onStart: () => void; onStop: () => void;
}) {
  const files = sending?.files ?? paths.map(path => ({ id: path, name: path.split(/[\\/]/).pop() || path, size: null }));
  return <section aria-label="发送文件">
    <div className="quick-transfer-status">
      <span className={`quick-transfer-live${sending ? " is-active" : ""}`}><i />{sending ? "发送已开启" : "发送已关闭"}</span>
      <button type="button" className="quick-transfer-switch" role="switch" aria-label="发送开关" aria-checked={!!sending}
        disabled={disabled || (!sending && !canStart)} onClick={sending ? onStop : onStart}>
        <span>{sending ? "关闭发送" : "开启发送"}</span><i aria-hidden="true" />
      </button>
    </div>
    <div className="quick-transfer-queue-heading"><h3>本次发送 · {files.length}</h3>
      {!sending && <button type="button" className="quick-transfer-pick" disabled={disabled} onClick={onPick}><Plus size={14} />选择文件</button>}
    </div>
    <ul className="quick-transfer-queue">{files.map(file => <li className="quick-transfer-file" key={file.id}>
      <File size={18} aria-hidden="true" /><div className="quick-transfer-file-info"><p className="quick-transfer-file-name" title={file.name}>{file.name}</p>
        {file.size !== null && <p className="quick-transfer-file-meta">{quickTransferFileSize(file.size)}</p>}
      </div>{!sending && <button type="button" disabled={disabled} aria-label={`移除 ${file.name}`} onClick={() => onRemove(file.id)}><X size={14} /></button>}
    </li>)}</ul>
  </section>;
}
