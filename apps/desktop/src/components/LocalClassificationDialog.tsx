import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { globalClassification, localClassification, projectClassification, type ClassificationLabel, type LocalClassificationStatus } from "../lib/localClassification";
import { folderClassification } from "../lib/folderClassification";
import { open } from "@tauri-apps/plugin-dialog";
import { Plus } from "lucide-react";
import { useStore } from "../store";
import { ModalShell } from "./ModalShell";
import { ConfirmDialog } from "./ConfirmDialog";
import { ClassificationPlayback } from "./ClassificationPlayback";
import { ClassificationDiagnostics } from "./ClassificationDiagnostics";

function JevResults({ progress }: { progress: NonNullable<LocalClassificationStatus["jev_progress"]> }) {
  const report = progress.report;
  return <section aria-label="Jev 返回结果" className="overflow-hidden rounded-lg border border-edge">
    <div className="space-y-2 p-3">
      <h5 className="font-medium">Jev 返回结果</h5>
      <p className="text-xs text-muted break-all">素材：{progress.asset.name}</p>
      <p className="text-xs" role="status">{progress.message}</p>
      <p className="text-xs text-muted">所有启用标签统一按原始概率排序，最多取 4 个且每个不低于 30%；「无明显匹配项」参与判断，不保存为标签。</p>
      {!report && <p className="text-xs text-muted">暂无 Jev 返回内容</p>}
    </div>
    {report && <>
      <section aria-label="Jev 标签排名" className="border-t border-edge">
        <div className="space-y-1 bg-panel2 px-3 py-2 text-xs">
          <h6 className="font-medium">全部候选 · Choice</h6>
          <p>{report.no_match === null ? "结果不完整，未采用" : report.no_match ? "没有真实标签达到 30%，转 Cloud 补充" : "已按概率与 30% 门槛选出标签"}</p>
          <p className="text-muted">{report.model}{report.confidence !== null && ` · 置信度 ${(report.confidence * 100).toFixed(2)}%`}</p>
        </div>
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full table-fixed text-xs">
            <thead><tr className="border-b border-edge text-left text-muted">
              <th className="w-2/3 px-3 py-2 font-normal">候选标签与说明</th>
              <th className="px-3 py-2 font-normal">概率</th>
            </tr></thead>
            <tbody>
              {report.labels.map((label, index) => <tr key={label.key} className={`border-b border-edge align-top ${label.selected ? "bg-cold/5" : ""}`}>
                <td className="px-3 py-3">
                  <p className="break-all text-[10px] font-medium">{label.probability !== null ? `${index + 1}. ` : ""}{label.name}</p>
                  {label.selected && <p className="mt-1 text-cold">选中标签</p>}
                  <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed text-muted">{label.description}</p>
                </td>
                <td className="px-3 py-3">
                  {label.probability === null ? <span className="text-muted">无有效概率</span> : <div className="flex items-center gap-2">
                    <span className="font-mono tabular-nums" title={String(label.probability)}>{(label.probability * 100).toFixed(2)}%</span>
                    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-cold" aria-hidden="true">
                      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="4" opacity="0.2" />
                      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="4" pathLength="100"
                        strokeDasharray={`${label.probability * 100} 100`} transform="rotate(-90 10 10)" />
                    </svg>
                  </div>}
                </td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </section>
      <div className="space-y-2 p-3">
        <p className="text-xs text-muted">使用候选原始概率，不重新归一化，也不以 Choice 整体置信度代替。只有没有合格标签时才由 Cloud 补充。</p>
        {report.error && <p className="text-xs text-red-400">本图未采用：{report.error}</p>}
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">查看 Jev 原始返回</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-panel2 p-2">{JSON.stringify(report.response, null, 2)}</pre>
        </details>
      </div>
    </>}
  </section>;
}

export function LocalClassificationDialog({ onClose, projectId, folder, globalScope = false, globalPaths, selectedFiles, onFilter, initialView = "classification" }: { onClose: () => void; projectId?: string; folder?: { root: string; recursive: boolean }; globalScope?: boolean; globalPaths?: string[]; selectedFiles?: Set<string>; onFilter?: (id: string) => void; initialView?: "classification" | "labels" }) {
  const [target, setTarget] = useState(folder);
  return <ClassificationSettings key={target?.root ?? "library"} projectId={projectId} allowFolderSelection={!!folder} globalScope={globalScope && !target} globalPaths={globalPaths} initialView={initialView} onClose={onClose} folder={target} selectedFiles={target?.root === folder?.root ? selectedFiles : undefined} onFilter={target?.root === folder?.root ? onFilter : undefined} onTarget={setTarget} />;
}

function ClassificationSettings({ onClose, folder, globalScope, globalPaths, selectedFiles, onFilter, onTarget, initialView, allowFolderSelection, projectId }: {
  allowFolderSelection: boolean; projectId?: string;
  globalScope: boolean; globalPaths?: string[];
  onClose: () => void; folder?: { root: string; recursive: boolean }; selectedFiles?: Set<string>; onFilter?: (id: string) => void;
  onTarget: (folder: {root:string; recursive:boolean} | undefined) => void;
  initialView: "classification" | "labels";
}) {
  const view = initialView;
  const [recursive, setRecursive] = useState(folder?.recursive ?? false);
  const local = folder ? folderClassification.client(folder.root, recursive) : globalScope ? {
    ...localClassification, start: globalClassification.start,
    labels: async () => (await globalClassification.view(globalPaths ?? [])).labels,
  } : projectId ? projectClassification(projectId) : localClassification;
  const [status, setStatus] = useState<LocalClassificationStatus | null>(null);
  const [labels, setLabels] = useState<ClassificationLabel[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<ClassificationLabel[]>([]);
  const [reclassify, setReclassify] = useState(false);
  const [confirmRescan, setConfirmRescan] = useState(false);
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const projectName = useStore(s => s.projects.find(p => p.id === projectId)?.name);
  const projectAssets = useStore(s => s.assets);
  const librarySelected = useStore((s) => s.selectedIds);
  const selected = folder || globalScope ? (selectedFiles ?? new Set<string>()) : projectId ? new Set([...librarySelected].filter(id => projectAssets.some(asset => asset.id === id))) : librarySelected;
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
    const unlisten = listen<LocalClassificationStatus>("local-classification://progress", event => {
      if (active) setStatus(event.payload);
    }).catch(() => () => {});
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { active = false; window.clearInterval(timer); void unlisten.then(stop => stop()); };
  }, []);

  async function action(fn: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true; setWorking(true); setError("");
    try { await fn(); await refresh(); }
    catch (e) { setError(String(e)); }
    finally { lock.current = false; setWorking(false); }
  }
  function edit(label?: ClassificationLabel) {
    setEditorOpen(true);
    setEditing(label?.id ?? null); setName(label?.name ?? "");
    setDescription(label?.description ?? ""); setEnabled(label?.enabled ?? true);
  }
  const busy = working || !!status?.busy;
  const canRun = !!status && !busy;
  const canMatch = canRun;
  const statusIsCloud = !!status?.model.startsWith("jev-") || !!status?.model.includes("/jev-");
  const sameTarget = (status?.project_id ?? null) === (projectId ?? null) && (status?.folder_root ?? null) === (folder?.root ?? null)
    && (!!status?.global_scope === globalScope || (!folder && status?.phase === "downloading"));
  const showProgress = status && sameTarget;
  const jevResults = status?.jev_progress && <JevResults key={status.jev_progress.asset.id} progress={status.jev_progress} />;
  async function ensureCloud() {
    if (!(await local.jevConfig()).enabled) await local.saveJevConfig(true);
  }
  async function startClassification(options: { tagId?: string; pendingOnly?: boolean } = {}) {
    await ensureCloud();
    await local.start(options);
  }
  function requestClassification() {
    if (!canRun) return;
    if (reclassify) { setError(""); setConfirmRescan(true); }
    else void action(() => startClassification({ pendingOnly: true }));
  }
  const checkedLabels = labels.filter((label) => selectedLabels.has(label.id));
  function requestDelete(targets: ClassificationLabel[]) {
    setError(""); setNotice(""); setDeleting(targets);
  }
  async function deleteLabels() {
    await action(async () => {
      await local.deleteLabels(deleting.map((label) => label.id));
      if (deleting.some((label) => label.id === editing)) setEditorOpen(false);
      if (!folder && deleting.some((label) => useStore.getState().smartFilter === `tag:${label.name}`)) setSmartFilter(null);
      setSelectedLabels((current) => new Set([...current].filter((id) => !deleting.some((label) => label.id === id))));
      setLabels((current) => current.filter((label) => !deleting.some((target) => target.id === label.id)));
      setNotice(`已删除 ${deleting.length} 个标签，素材文件已保留。`);
      setDeleting([]);
    });
  }
  const targetName = folder ? "指定文件夹" : globalScope ? "全局素材" : projectId ? `项目 · ${projectName || "当前项目"}` : "素材库";
  const runControls = <div className="classification-run-controls">
    <div className="classification-run-buttons">
      <button className="app-modal-button is-primary classification-start" disabled={!canRun} onClick={requestClassification}>进行分类</button>
      {status?.busy && sameTarget && <button className="app-modal-button" disabled={working} onClick={() => void action(() => local.stop())}>停止</button>}
    </div>
    <label className="classification-run-option">
      <input type="checkbox" checked={reclassify} disabled={busy} onChange={e => setReclassify(e.target.checked)} />
      重新分类已有标签的素材
    </label>
  </div>;

  return <><ModalShell title={view === "labels" ? "管理分类数据" : "自动分类"} width="md" className="classification-panel" onClose={onClose} preventClose={deleting.length > 0 || confirmRescan}
    description={view === "classification" ? "使用云端分类，优先匹配已有标签。" : undefined}
    footer={view === "labels" ? <div className="classification-run-footer">
      <div className="classification-run-target">
        <span className="text-xs text-muted">分类目标</span>
        <p className="text-sm font-medium" title={folder?.root ?? targetName}>{targetName}</p>
        {folder && <p className="text-xs text-muted" title={folder.root}>{folder.root}</p>}
        {showProgress && status.busy && <p role="status" className="text-xs text-muted">{status.message || "正在分类…"}</p>}
      </div>
      {runControls}
    </div> : undefined}>
    <div className="space-y-3 text-sm">
      {(view === "classification" || allowFolderSelection || (status?.busy && !sameTarget)) && <section className="space-y-2" aria-label="分类目标">
        {view === "classification" && <p className="font-medium">分类目标：{targetName}</p>}
        {folder && view === "classification" && <><p className="break-all text-xs">{folder.root}</p>
          <label className="flex items-center gap-2"><input type="checkbox" checked={recursive} disabled={busy} onChange={e => setRecursive(e.target.checked)} />包含子文件夹</label></>}
        {allowFolderSelection && <div className="flex gap-2">
          {folder && <button className="app-modal-button" disabled={busy} onClick={() => onTarget(undefined)}>选择素材库</button>}
          <button className="app-modal-button" disabled={busy} onClick={() => void action(async () => {
            const path = await open({ directory: true, multiple: false });
            if (typeof path === "string") { const view = await folderClassification.view(path); onTarget({ root: view.root, recursive: view.record.recursive }); }
          })}>选择目标文件夹</button>
        </div>}
        {status?.folder_root && status.busy && <p role="status" className="text-xs break-all">正在分类文件夹：{status.folder_root}</p>}
        {status?.busy && !sameTarget && <div className="space-y-2"><p role="status">另一分类范围的任务正在运行，完成或停止后可处理当前目标。</p><button className="app-modal-button" disabled={working} onClick={() => void action(() => local.stop())}>停止当前任务</button></div>}
      </section>}
      {error && <p role="alert" className="text-red-400">{error}</p>}
      <ClassificationPlayback status={showProgress ? status : null} />
      {import.meta.env.DEV && showProgress && status && <ClassificationDiagnostics status={status} />}
      {view === "classification" && <section aria-label="云端分类" className="rounded-lg border border-edge p-4 space-y-3">
        <div className="space-y-1">
          <h3 className="font-medium">云端分类</h3>
          <p className="text-xs text-muted">优先匹配已有标签，没有合适类别时再补充新标签。</p>
          <p className="text-xs text-muted">累计 5 张图片获得标签扣 1 积分，未满 5 张跨批次累计；无法判断或请求失败不计数。</p>
        </div>
        {runControls}
        {!folder && !globalScope && !projectId && <label className="flex items-center gap-2">
          <input type="checkbox" checked={status?.enabled ?? false} disabled={!status || working || (!status.enabled && status.busy)}
            onChange={(e) => { const enabled = e.target.checked; void action(async () => { if (enabled) await ensureCloud(); await local.enable(enabled); }); }} />
          自动处理新素材
        </label>}
        {folder && <p className="text-xs text-muted">按需扫描当前文件夹，关闭面板后任务继续。</p>}
        {globalScope && <p className="text-xs text-muted">按需扫描已添加位置，离线或不可读文件会跳过并显示原因。</p>}
        {showProgress && <>
          {statusIsCloud && jevResults}
          {status.message && <p role="status" aria-live="polite">{status.message}</p>}
          {status.last_error && <p className="text-xs text-red-400">最近一次未完成原因：{status.last_error}</p>}
          {status.total > 0 && <p className="text-xs text-muted">已尝试 {status.done} / {status.total} · 成功 {Math.max(0, status.done - status.failed)} · 未完成 {status.failed}</p>}
        </>}
      </section>}
      <div className={`flex items-center justify-between ${view === "classification" ? "border-t border-edge pt-3" : ""}`}>
        <h3 className="font-medium">已有标签 · {labels.length}</h3>
        <button className="app-modal-button inline-flex items-center gap-1" disabled={working} onClick={() => edit()}><Plus size={14} />新建标签</button>
      </div>
      {editorOpen && <section className="space-y-2 rounded-lg border border-edge bg-panel2/50 p-3">
        <h3 className="font-medium">{editing ? "编辑分类标签" : "新建分类标签"}</h3>
        <input aria-label="标签名称" className="w-full rounded border border-edge bg-panel2 px-3 py-2" maxLength={40}
          autoFocus placeholder="例如：水彩植物、手工感包装" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea aria-label="分类说明" className="w-full rounded border border-edge bg-panel2 px-3 py-2" rows={2} maxLength={600}
          placeholder="可选：描述你想收进此标签的素材，尤其是风格或个人命名。" value={description} onChange={(e) => setDescription(e.target.value)} />
        <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />允许自动匹配此标签</label>
        <div className="flex flex-wrap gap-2">
          <button className="app-modal-button" disabled={working || !name.trim()} onClick={() => void action(async () => {
            await local.save(editing, name, description, enabled); setEditorOpen(false);
          })}>保存标签</button>
          <button className="app-modal-button" disabled={!canMatch || !name.trim() || !enabled} onClick={() => void action(async () => {
            const id = await local.save(editing, name, description, enabled);
            setEditing(id);
            await startClassification({ tagId: id }); setEditorOpen(false);
          })}>保存并寻找匹配素材</button>
          <button className="app-modal-button" disabled={working} onClick={() => setEditorOpen(false)}>取消</button>
        </div>
      </section>}

      <section className="space-y-2">
        {notice && <p role="status" className="text-xs text-muted">{notice}</p>}
        {labels.length > 0 && <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={checkedLabels.length === labels.length} disabled={busy}
              ref={(input) => { if (input) input.indeterminate = checkedLabels.length > 0 && checkedLabels.length < labels.length; }}
              onChange={(e) => setSelectedLabels(e.target.checked ? new Set(labels.map((label) => label.id)) : new Set())} />
            全选标签
          </label>
          <span className="text-xs text-muted">已选 {checkedLabels.length} 个</span>
          <button className="app-modal-button is-danger" disabled={busy || checkedLabels.length === 0}
            onClick={() => requestDelete(checkedLabels)}>删除所选标签</button>
        </div>}
        {status?.busy && labels.length > 0 && <p className="text-xs text-muted">请先停止当前任务，再删除标签。</p>}
        {labels.length === 0 && <p className="text-muted py-3">还没有标签。识别图片后会自动发现，也可以先创建。</p>}
        <div className="classification-label-list divide-y divide-edge">
          {labels.map((label) => <div key={label.id} className="py-2 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <input type="checkbox" aria-label={`选择标签 ${label.name}`} checked={selectedLabels.has(label.id)} disabled={busy}
                onChange={(e) => setSelectedLabels((current) => {
                  const next = new Set(current);
                  if (e.target.checked) next.add(label.id); else next.delete(label.id);
                  return next;
                })} />
              <button className="text-cold font-medium" disabled={!!folder && !onFilter} title={folder && !onFilter ? "在本机文件中打开该目录后可按标签筛选" : undefined} onClick={() => { if (folder || globalScope) onFilter?.(label.id); else setSmartFilter(`tag:${label.name}`); onClose(); }}>#{label.name}</button>
              <span className="text-xs text-muted">{label.count} 张{!label.enabled && " · 已停用自动匹配"}</span>
              <button className="text-xs" onClick={() => edit(label)}>编辑</button>
              <button className="text-xs text-red-400 disabled:opacity-40" aria-label={`删除标签 ${label.name}`} disabled={busy}
                onClick={() => requestDelete([label])}>删除</button>
              <button className="text-xs disabled:opacity-40" disabled={!canMatch || !label.enabled} onClick={() => void action(() => startClassification({ tagId: label.id }))}>寻找匹配</button>
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
  </ModalShell>
    <ConfirmDialog open={confirmRescan} title="确认重新分类" danger
      message={<>此操作会删除当前范围内参与重分类素材的已有自动标签，再重新分类，是否确认？已有人工归类的素材会跳过，人工正反例及来源不明的旧版归属会保留。
        {error && <span role="alert" className="block text-red-400">{error}</span>}
      </>}
      confirmLabel={working ? "正在开始…" : "确认并进行分类"} confirmDisabled={!canRun}
      onConfirm={() => { if (canRun) void action(async () => { await startClassification({ pendingOnly: false }); setConfirmRescan(false); }); }}
      onCancel={() => { if (!lock.current) { setConfirmRescan(false); setError(""); } }} />
    <ConfirmDialog open={deleting.length > 0} title={deleting.length === 1 ? `删除标签「${deleting[0].name}」` : `删除 ${deleting.length} 个标签`}
      message={<>
        {folder ? "将从此文件夹的分类记录中移除这些标签，并删除相关示例、排除记录和待匹配任务。仅影响上述分类范围，独立分类目录和素材库不受影响。" : "将从本机全局索引（含历史素材）中移除这些标签，并删除相关示例、排除记录和待匹配任务。各目录的独立分类记录保留。"}素材文件会保留，此操作无法撤销。后续重新识别仍可能生成同名标签。
        {error && <span role="alert" className="block text-red-400">{error}</span>}
      </>}
      confirmLabel={working ? "正在删除…" : "确认删除"} danger confirmDisabled={busy}
      onConfirm={() => void deleteLabels()} onCancel={() => { if (!lock.current) { setDeleting([]); setError(""); } }} />
  </>;
}
