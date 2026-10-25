import { userErrorMessage } from "../lib/userError";
import { useEffect, useRef, useState } from "react";
import { fileWorkspace, type RestorePreview } from "../lib/fileWorkspace";
import { ModalShell } from "./ModalShell";

export function FileRecordsDialog({ root, onClose, onRestored }: { root: string; onClose: () => void; onRestored: () => void }) {
  const [recursive, setRecursive] = useState(false);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const request = useRef(0);
  const alive = useRef(true);
  const operation = useRef(false);
  async function scan(includeChildren: boolean) {
    const version = ++request.current;
    setBusy(true); setPreview(null); setError("");
    try {
      const value = await fileWorkspace.previewRestore(root, includeChildren);
      if (alive.current && version === request.current) setPreview(value);
    } catch (reason) { if (alive.current && version === request.current) setError(String(reason)); }
    finally { if (alive.current && version === request.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true; void scan(recursive);
    return () => { alive.current = false; request.current++; };
  }, [root, recursive]);
  async function apply() {
    if (!preview || operation.current) return;
    operation.current = true; setWriting(true); setError(""); setMessage("");
    try {
      const result = await fileWorkspace.restore(root, recursive, preview.token);
      if (!alive.current) return;
      setMessage(`已恢复 ${result.imported} 项资料，修复 ${result.relinked} 项引用。`);
      onRestored();
      await scan(recursive);
    } catch (reason) {
      if (alive.current) { setError(String(reason)); setPreview(null); }
    } finally { operation.current = false; if (alive.current) setWriting(false); }
  }
  async function save() {
    if (operation.current) return;
    operation.current = true; setWriting(true); setError(""); setMessage("");
    try {
      const result = await fileWorkspace.saveRecords(root);
      if (!alive.current) return;
      setMessage(`当前文件夹已登记 ${result.total} 项；${result.pending} 项等待重试，${result.local} 项资料保存在本机。`);
      await scan(recursive);
    } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { operation.current = false; if (alive.current) setWriting(false); }
  }
  const ready = preview?.items.filter(item => item.action === "import" || item.action === "relink").length ?? 0;
  return <ModalShell title="随图资料" width="lg" onClose={onClose} preventClose={writing}
    description="读取文件夹中的资料以恢复描述、生成参数、标签和提示词。已有素材保留本机资料，仅修复失效引用；原文件保留在当前位置。"
    footer={<><button className="app-button-secondary" disabled={writing} onClick={onClose}>关闭</button>
      <button className="app-button-primary" disabled={!ready || busy || writing} onClick={() => void apply()}>{writing ? "正在处理…" : `恢复可用项（${ready}）`}</button></>}>
    <p className="text-xs break-all opacity-70">{root}</p>
    <div className="flex flex-wrap items-center gap-3 my-3 text-sm">
      <label className="flex items-center gap-2"><input type="checkbox" checked={recursive} disabled={writing || busy} onChange={e => { setMessage(""); setRecursive(e.target.checked); }} />包含子文件夹</label>
      <button className="app-button-secondary" disabled={busy || writing} onClick={() => void scan(recursive)}>重新预览</button>
      <button className="app-button-secondary" disabled={busy || writing} onClick={() => void save()}>保存当前文件夹资料</button>
    </div>
    <p className="text-xs opacity-70">保存仅处理当前层已登记的素材，用于更新旧版随图资料；只读目录的资料保存在本机。恢复不会重新启动生成任务或重建整个画板。</p>
    {busy && <p role="status" className="my-3 text-sm">正在校验文件内容…</p>}
    {message && <p role="status" className="my-3 text-sm">{message}</p>}
    {error && <p role="alert" className="folder-error">{userErrorMessage(error, "随图资料处理未完成，请检查文件夹后重试。")}</p>}
    {preview && !preview.items.length && <p className="my-4 text-sm">未找到随图资料。可先在原设备保存资料，再将图片连同 .bowerbird 文件夹一起复制。</p>}
    {!!preview?.items.length && <ul className="space-y-2 my-4 max-h-[45vh] overflow-auto" aria-label="资料恢复预览">
      {preview.items.map(item => <li key={item.record_path} className="border border-line rounded-lg p-3 text-sm">
        <div className="break-all font-medium">{item.file}</div>
        <p className="mt-1 text-xs opacity-70">{item.action === "blocked" ? userErrorMessage(item.message, "这份资料无法恢复，请检查文件是否完整。") : item.message}</p>
      </li>)}
    </ul>}
  </ModalShell>;
}
