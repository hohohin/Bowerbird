import { LearningHint } from "./OnboardingTour";
import { useEffect, useRef, useState } from "react";
import { localClassification as local, type ClassificationLabel, type LocalClassificationStatus } from "../lib/localClassification";
import { useStore } from "../store";
import { ModalShell } from "./ModalShell";

export function LocalClassificationDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<LocalClassificationStatus | null>(null);
  const [labels, setLabels] = useState<ClassificationLabel[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const lock = useRef(false);
  const selected = useStore((s) => s.selectedIds);
  const setSmartFilter = useStore((s) => s.setSmartFilter);

  async function refresh() {
    const [nextStatus, nextLabels] = await Promise.all([local.status(), local.labels()]);
    setStatus(nextStatus);
    setLabels(nextLabels);
  }
  useEffect(() => {
    let active = true;
    let fetching = false;
    const poll = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const [nextStatus, nextLabels] = await Promise.all([local.status(), local.labels()]);
        if (active) { setStatus(nextStatus); setLabels(nextLabels); }
      } catch (e) { if (active) setError(String(e)); }
      finally { fetching = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  async function action(fn: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true; setWorking(true); setError("");
    try { await fn(); await refresh(); }
    catch (e) { setError(String(e)); }
    finally { lock.current = false; setWorking(false); }
  }
  function edit(label?: ClassificationLabel) {
    setEditing(label?.id ?? null); setName(label?.name ?? "");
    setDescription(label?.description ?? ""); setEnabled(label?.enabled ?? true);
  }
  const busy = working || !!status?.busy;
  const canRun = !!status?.installed && !!status.supported && !busy;

  return <ModalShell title="本地分类" width="lg" onClose={onClose}
    description="从图片内容与风格发现标签，也可按你创建的标签寻找素材。图片识别在本机完成。">
    <div className="space-y-5 text-sm">
      <LearningHint topic="classification" />
      {error && <p role="alert" className="text-red-400">{error}</p>}
      <section className="rounded border border-edge bg-panel2 p-3 space-y-3">
        <p>{status?.installed ? "本地模型已安装 · 无需账号或积分" : "首次下载约 756 MB，安装后可离线使用。"}</p>
        {status && !status.supported && <p className="text-muted">此模型包目前支持 Windows x64。</p>}
        <div className="flex flex-wrap gap-2">
          {!status?.installed && <button className="app-modal-button" disabled={!status?.supported || busy} onClick={() => void action(() => local.start({ install: true }))}>下载本地模型</button>}
          {status?.installed && <>
            <button className="app-modal-button" disabled={!canRun} onClick={() => void action(() => local.start())}>识别未处理素材</button>
            <button className="app-modal-button" disabled={!canRun} onClick={() => void action(() => local.start({ pendingOnly: false }))}>重新扫描全部图片</button>
            <button className="app-modal-button" disabled={busy} onClick={() => void action(() => local.start({ install: true }))}>修复模型安装</button>
          </>}
          {status?.busy && <button className="app-modal-button" disabled={working} onClick={() => void action(() => local.stop())}>停止</button>}
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={status?.enabled ?? false} disabled={!status?.installed || working}
            onChange={(e) => void action(() => local.enable(e.target.checked))} />
          自动识别新素材，并匹配新增或修改的标签
        </label>
        <p className="text-xs text-muted">手动添加的标签会保留；你移除的标签不会自动贴回。停止任务也会暂停自动处理。</p>
        {status?.message && <p role="status" aria-live="polite">{status.message}</p>}
        {status?.last_error && <p className="text-xs text-red-400">最近一次未完成原因：{status.last_error}</p>}
        {status?.busy && status.phase === "downloading" && <>
          <progress className="w-full" value={status.download_done} max={status.download_total || 1} />
          <p className="text-xs text-muted">{Math.round(status.download_done / 1048576)} / {Math.round(status.download_total / 1048576)} MiB · 可关闭面板，下载继续</p>
        </>}
        {status?.total ? <p className="text-xs text-muted">已处理 {status.done} / {status.total} · 未完成 {status.failed}</p> : null}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between"><h3 className="font-medium">{editing ? "编辑分类标签" : "新建分类标签"}</h3>
          {editing && <button className="text-cold" onClick={() => edit()}>新建标签</button>}
        </div>
        <input aria-label="标签名称" className="w-full rounded border border-edge bg-panel2 px-3 py-2" maxLength={40}
          placeholder="例如：水彩植物、手工感包装" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea aria-label="分类说明" className="w-full rounded border border-edge bg-panel2 px-3 py-2" rows={2} maxLength={600}
          placeholder="可选：描述你想收进此标签的素材，尤其是风格或个人命名。" value={description} onChange={(e) => setDescription(e.target.value)} />
        <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />允许自动匹配此标签</label>
        <div className="flex flex-wrap gap-2">
          <button className="app-modal-button" disabled={working || !name.trim()} onClick={() => void action(async () => {
            await local.save(editing, name, description, enabled); edit();
          })}>保存标签</button>
          <button className="app-modal-button" disabled={!canRun || !name.trim() || !enabled} onClick={() => void action(async () => {
            const id = await local.save(editing, name, description, enabled);
            edit(); await local.start({ tagId: id });
          })}>保存并寻找匹配素材</button>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">已有标签 · {labels.length}</h3>
        <p className="text-xs text-muted">先在素材库多选图片，再将它们设为某个标签的示例或反例。模型不会从自己的自动标签中学习偏好。</p>
        {labels.length === 0 && <p className="text-muted py-3">还没有标签。识别图片后会自动发现，也可以先创建。</p>}
        <div className="max-h-64 overflow-y-auto divide-y divide-edge">
          {labels.map((label) => <div key={label.id} className="py-2 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <button className="text-cold font-medium" onClick={() => { setSmartFilter(`tag:${label.name}`); onClose(); }}>#{label.name}</button>
              <span className="text-xs text-muted">{label.count} 张{label.enabled ? "" : " · 已停用自动匹配"}</span>
              <button className="text-xs" onClick={() => edit(label)}>编辑</button>
              <button className="text-xs disabled:opacity-40" disabled={!canRun || !label.enabled} onClick={() => void action(() => local.start({ tagId: label.id }))}>寻找匹配</button>
              {selected.size > 0 && <>
                <button className="text-xs text-cold" disabled={working} onClick={() => void action(() => local.example(label.id, [...selected], true))}>加入所选 {selected.size} 张作为示例</button>
                <button className="text-xs" disabled={working} onClick={() => void action(() => local.example(label.id, [...selected], false))}>排除所选素材</button>
              </>}
            </div>
            {label.description && <p className="text-xs text-muted">{label.description}</p>}
          </div>)}
        </div>
      </section>
    </div>
  </ModalShell>;
}
