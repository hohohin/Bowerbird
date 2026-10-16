import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { localClassification, type ClassificationLabel, type LocalClassificationStatus } from "../lib/localClassification";
import { folderClassification } from "../lib/folderClassification";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore } from "../store";
import { ModalShell } from "./ModalShell";
import { ConfirmDialog } from "./ConfirmDialog";

function ProcessingAsset({ asset, total }: { asset: NonNullable<LocalClassificationStatus["current_asset"]>; total: number }) {
  const [failed, setFailed] = useState(false);
  return <div className="flex items-center gap-3 rounded-lg border border-edge bg-panel2 p-3" aria-label="当前处理素材">
    <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded bg-panel">
      {asset.thumb_path && !failed
        ? <img src={convertFileSrc(asset.thumb_path)} alt={`正在处理：${asset.name}`} className="h-full w-full object-contain" onError={() => setFailed(true)} />
        : <span className="text-xs text-muted">暂无缩略图</span>}
    </div>
    <div className="min-w-0 space-y-1">
      <p className="text-xs text-muted" role="status">正在分析 · 第 {asset.position} / {total} 张</p>
      <p className="line-clamp-2 break-all font-medium" title={asset.name}>{asset.name}</p>
    </div>
  </div>;
}

function JevResults({ progress }: { progress: NonNullable<LocalClassificationStatus["jev_progress"]> }) {
  const report = progress.report;
  return <section aria-label="Jev 返回结果" className="overflow-hidden rounded-lg border border-edge">
    <div className="space-y-2 p-3">
      <h5 className="font-medium">Jev 返回结果</h5>
      <p className="text-xs text-muted break-all">素材：{progress.asset.name}</p>
      <p className="text-xs" role="status">{progress.message}</p>
      <p className="text-xs text-muted">类型、风格、主体分别选一个标签；各维度内按候选概率排序。自动分类仅通过 Cloud 补充未匹配的维度。</p>
      {!report && <p className="text-xs text-muted">暂无 Jev 返回内容</p>}
    </div>
    {report && <>
      {report.dimensions.map(dimension => <section key={dimension.dimension} aria-label={`Jev ${dimension.title}结果`} className="border-t border-edge">
        <div className="space-y-1 bg-panel2 px-3 py-2 text-xs">
          <h6 className="font-medium">{dimension.title} · Choice</h6>
          <p>{dimension.no_match === null ? "结果不完整，未采用" : dimension.no_match ? "此维度无已有匹配标签" : "已选出此维度的标签"}</p>
          <p className="text-muted">{report.model}{dimension.confidence !== null && ` · 置信度 ${(dimension.confidence * 100).toFixed(2)}%`}</p>
        </div>
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full table-fixed text-xs">
            <thead><tr className="border-b border-edge text-left text-muted">
              <th className="w-2/3 px-3 py-2 font-normal">候选标签与说明</th>
              <th className="px-3 py-2 font-normal">概率</th>
            </tr></thead>
            <tbody>
              {dimension.labels.map((label, index) => <tr key={label.key} className={`border-b border-edge align-top ${label.selected ? "bg-cold/5" : ""}`}>
                <td className="px-3 py-3">
                  <p className="break-all text-[10px] font-medium">{label.probability !== null ? `${index + 1}. ` : ""}{label.name}</p>
                  {label.selected && <p className="mt-1 text-cold">{label.key === "no_match" ? "本维度无匹配" : "选中标签"}</p>}
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
        {dimension.error && <p className="p-3 text-xs text-red-400">{dimension.error}</p>}
      </section>)}
      <div className="space-y-2 p-3">
        <p className="text-xs text-muted">每个维度取 Jev 返回的最高概率选项，各维度之间不比较概率。整图完成后保存为普通标签，重复标签只保存一次。</p>
        {report.error && <p className="text-xs text-red-400">本图未采用：{report.error}</p>}
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">查看 Jev 原始返回</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-panel2 p-2">{JSON.stringify(report.response, null, 2)}</pre>
        </details>
      </div>
    </>}
  </section>;
}

export function LocalClassificationDialog({ onClose, folder, selectedFiles, onFilter }: { onClose: () => void; folder?: { root: string; recursive: boolean }; selectedFiles?: Set<string>; onFilter?: (id: string) => void }) {
  const [target, setTarget] = useState(folder);
  return <ClassificationSettings key={target?.root ?? "library"} onClose={onClose} folder={target} selectedFiles={target?.root === folder?.root ? selectedFiles : undefined} onFilter={target?.root === folder?.root ? onFilter : undefined} onTarget={setTarget} />;
}

function ClassificationSettings({ onClose, folder, selectedFiles, onFilter, onTarget }: {
  onClose: () => void; folder?: { root: string; recursive: boolean }; selectedFiles?: Set<string>; onFilter?: (id: string) => void;
  onTarget: (folder: {root:string; recursive:boolean} | undefined) => void;
}) {
  const [recursive, setRecursive] = useState(folder?.recursive ?? false);
  const local = folder ? folderClassification.client(folder.root, recursive) : localClassification;
  const [status, setStatus] = useState<LocalClassificationStatus | null>(null);
  const [labels, setLabels] = useState<ClassificationLabel[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<ClassificationLabel[]>([]);
  const [notice, setNotice] = useState("");
  const [cloudSelected, setCloudSelected] = useState(false);
  const [jevKey, setJevKey] = useState("");
  const [cloudActive, setCloudActive] = useState(false);
  const [savedKey, setSavedKey] = useState("");
  const [configLoaded, setConfigLoaded] = useState(false);
  const lock = useRef(false);
  const librarySelected = useStore((s) => s.selectedIds);
  const selected = folder ? (selectedFiles ?? new Set<string>()) : librarySelected;
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

  useEffect(() => {
    let active = true;
    void local.jevConfig().then((config) => {
      if (!active) return;
      setCloudSelected(config.enabled);
      setJevKey(config.apiKey);
      setCloudActive(config.enabled);
      setSavedKey(config.apiKey);
      setConfigLoaded(true);
    }).catch((e) => { if (active) setError(`无法读取分类设置：${String(e)}，请关闭面板后重试。`); });
    return () => { active = false; };
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
  const modeChanged = cloudSelected !== cloudActive;
  const configChanged = modeChanged || (cloudSelected && jevKey.trim() !== savedKey);
  const modeReady = configLoaded && !configChanged && (cloudActive ? !!savedKey : !!status?.installed && !!status.supported);
  const canRun = !busy && modeReady;
  const canMatch = canRun;
  const statusIsCloud = !!status?.model.startsWith("jev-") || !!status?.model.includes("/jev-");
  const sameTarget = (status?.folder_root ?? null) === (folder?.root ?? null);
  const showProgress = status && sameTarget && cloudSelected === statusIsCloud && (status.busy || cloudSelected === cloudActive);
  const currentAsset = sameTarget && status?.busy && status.phase === "classifying" ? status.current_asset : null;
  const processingPreview = currentAsset && <ProcessingAsset key={`${currentAsset.id}:${currentAsset.thumb_path}`} asset={currentAsset} total={status?.total ?? 0} />;
  const jevResults = status?.jev_progress && <JevResults key={status.jev_progress.asset.id} progress={status.jev_progress} />;
  async function saveMode() {
    await action(async () => {
      const key = cloudSelected ? jevKey.trim() : savedKey;
      await local.saveJevConfig(cloudSelected, key);
      setCloudActive(cloudSelected); setSavedKey(key); setJevKey(key);
    });
  }
  const checkedLabels = labels.filter((label) => selectedLabels.has(label.id));
  function requestDelete(targets: ClassificationLabel[]) {
    setError(""); setNotice(""); setDeleting(targets);
  }
  async function deleteLabels() {
    await action(async () => {
      await local.deleteLabels(deleting.map((label) => label.id));
      if (deleting.some((label) => label.id === editing)) edit();
      if (!folder && deleting.some((label) => useStore.getState().smartFilter === `tag:${label.name}`)) setSmartFilter(null);
      setSelectedLabels((current) => new Set([...current].filter((id) => !deleting.some((label) => label.id === id))));
      setLabels((current) => current.filter((label) => !deleting.some((target) => target.id === label.id)));
      setNotice(`已删除 ${deleting.length} 个标签，素材文件已保留。`);
      setDeleting([]);
    });
  }

  return <><ModalShell title="自动分类" width="lg" onClose={onClose} preventClose={deleting.length > 0}
    description="选择分类方式，再识别素材。标签与人工修正由两种方式共用。">
    <div className="space-y-5 text-sm">
      <section className="space-y-2" aria-label="分类目标">
        <p className="font-medium">分类目标：{folder ? "指定文件夹" : "素材库"}</p>
        {folder && <><p className="break-all text-xs">{folder.root}</p><p className="text-xs text-muted">仅处理图片，记录保存在此目录的 .bowerbird 中，标签与主库隔离。</p>
          <label className="flex items-center gap-2"><input type="checkbox" checked={recursive} disabled={busy} onChange={e => setRecursive(e.target.checked)} />包含子文件夹</label></>}
        <div className="flex gap-2">
          {folder && <button className="app-modal-button" disabled={busy} onClick={() => onTarget(undefined)}>选择素材库</button>}
          <button className="app-modal-button" disabled={busy} onClick={() => void action(async () => {
            const path = await open({ directory: true, multiple: false });
            if (typeof path === "string") { const view = await folderClassification.view(path); onTarget({ root: view.root, recursive: view.record.recursive }); }
          })}>选择目标文件夹</button>
        </div>
        {status?.folder_root && status.busy && <p role="status" className="text-xs break-all">正在分类文件夹：{status.folder_root}</p>}
        {status?.busy && !sameTarget && <div className="space-y-2"><p role="status">另一分类范围的任务正在运行，完成或停止后可处理当前目标。</p><button className="app-modal-button" disabled={working} onClick={() => void action(() => local.stop())}>停止当前任务</button></div>}
      </section>
      {error && <p role="alert" className="text-red-400">{error}</p>}
      <fieldset disabled={!configLoaded || busy} className="space-y-2">
        <legend className="font-medium mb-2">分类方式</legend>
        <div className="grid grid-cols-2 gap-3">
          {[false, true].map((cloud) => <label key={String(cloud)} className={`flex items-start gap-2 rounded-lg border p-3 ${cloudSelected === cloud ? "border-cold bg-cold/10" : "border-edge bg-panel2"} ${!configLoaded || busy ? "opacity-60" : "cursor-pointer"}`}>
            <input type="radio" name="classification-mode" aria-label={cloud ? "云端分类" : "本地分类"} className="mt-1" checked={cloudSelected === cloud} onChange={() => setCloudSelected(cloud)} />
            <span className="min-w-0 space-y-1">
              <span className="block font-medium">{cloud ? "云端分类" : "本地分类"}</span>
              <span className="block text-xs text-muted">{cloud ? "在线匹配，按需补充标签" : "设备内识别，图片不上传"}</span>
            </span>
          </label>)}
        </div>
      </fieldset>
      <p className="text-xs text-muted" aria-live="polite">{configLoaded ? `当前使用：${cloudActive ? "云端分类" : "本地分类"}${status?.busy ? " · 任务进行中，停止后可切换" : ""}` : "正在读取分类设置…"}</p>

      {status?.busy && cloudSelected !== statusIsCloud && <div className="rounded border border-edge bg-panel2 p-3 space-y-2">
        <p role="status">{statusIsCloud ? "云端" : "本地"}分类任务正在运行，请先停止再应用新的分类方式。</p>
        {processingPreview}
        {statusIsCloud && jevResults}
        <button className="app-modal-button" disabled={working} onClick={() => void action(() => local.stop())}>停止</button>
      </div>}

      <section aria-label={cloudSelected ? "云端分类设置" : "本地分类设置"} className="rounded-lg border border-edge p-4 space-y-4">
        {cloudSelected ? <>
          <div>
            <h3 className="font-medium">云端分类</h3>
            <p className="mt-1 text-xs text-muted">先复用已有标签，仅在无匹配时补充新标签。</p>
          </div>
          <ol className="grid gap-3 sm:grid-cols-2">
            <li className="rounded bg-panel2 p-3 space-y-1">
              <p className="font-medium">1. Jev 匹配已有标签</p>
              <p className="text-xs text-muted">一次按类型、风格、主体进行三个 Choice 判断，每个维度从已有标签与「无匹配」中选一个。</p>
            </li>
            <li className="rounded bg-panel2 p-3 space-y-1">
              <p className="font-medium">2. Cloud 补充新标签</p>
              <p className="text-xs text-muted">只为选中「无匹配」的维度调用豆包，每个缺失维度最多补一个标签；保存为普通标签。</p>
            </li>
          </ol>
          <label className="block space-y-2">
            <span className="font-medium">Jev API Key</span>
            <input type="password" className="w-full rounded border border-edge bg-panel2 px-3 py-2"
              placeholder="console.typesafe.ai 申请的 API Key" value={jevKey} disabled={!configLoaded || busy}
              onChange={(e) => setJevKey(e.target.value)} />
          </label>
          <p className="text-xs text-muted">Bowerbird Cloud 沿用反推的登录、额度与计费，无需另配豆包 API Key。</p>
          <p className="text-xs text-muted">启用后，缩略图、人工正反例图片及标签说明会发送给 TypeSafe；无匹配时将目标缩略图发送给 Bowerbird Cloud。Jev 按 TypeSafe 规则计费。</p>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">云端处理说明</summary>
            <p className="mt-2">Jev 图片能力目前为实验功能。首次切换会重新处理旧引擎识别过的素材。调用失败时不写入该图结果，自动处理会暂停；单标签寻找匹配不会生成新标签。</p>
          </details>
        </> : <>
          <div>
            <h3 className="font-medium">本地分类</h3>
            <p className="mt-1 text-xs text-muted">下载模型后在设备内识别与匹配，图片不上传。</p>
          </div>
          <div className="rounded bg-panel2 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">图像识别模型</span>
              <span className="text-xs text-muted">{status?.installed ? "已安装" : "未安装"}</span>
            </div>
            <p className="text-xs text-muted">{status?.installed ? "本地标签发现模型已安装" : "首次下载约 756 MB，NVIDIA 加速组件另需约 645 MB。"}</p>
            <p className="text-xs text-muted">{status?.acceleration || "优先使用 NVIDIA GPU 加速，不可用时使用 CPU。"}</p>
            {status && !status.supported && <p className="text-xs text-muted">此模型包支持 Windows x64、macOS 13.3+（Intel / Apple Silicon）。</p>}
            <button className="app-modal-button" disabled={!configLoaded || !status?.supported || busy || modeChanged}
              onClick={() => void action(() => local.start({ install: true }))}>{status?.installed ? "修复模型安装" : "下载本地模型"}</button>
          </div>
          <div className="rounded bg-panel2 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">本地向量匹配（jina-clip-v2）</span>
              <span className="text-xs text-muted">{status?.vector_installed ? "已安装" : status?.vector_supported ? "可选安装" : "此平台暂不支持"}</span>
            </div>
            <p className="text-xs text-muted">按图片、标签文本和人工示例的相似度匹配；未安装时由图像识别模型判断。下载约 881 MB。</p>
            {status?.vector_supported && !status.vector_installed && <button className="app-modal-button" disabled={!configLoaded || busy || modeChanged}
              onClick={() => void action(() => local.vectorInstall())}>下载向量匹配模型</button>}
            {status?.vector_installed && <button className="app-modal-button" disabled={!configLoaded || busy || modeChanged}
              onClick={() => void action(() => local.vectorUninstall())}>卸载向量匹配模型</button>}
          </div>
          <p className="text-xs text-muted">自动识别新素材，并为设过示例的标签匹配图片。未设示例的标签仅用于统一命名，也可手动寻找匹配。</p>
        </>}
        {(cloudSelected || modeChanged) && <div className="space-y-2">
          <button className="app-modal-button is-primary" disabled={!configLoaded || busy || !configChanged || (cloudSelected && !jevKey.trim())}
            onClick={() => void saveMode()}>{modeChanged ? `应用${cloudSelected ? "云端" : "本地"}分类` : "保存云端设置"}</button>
          {configChanged && <p className="text-xs text-muted">{modeChanged ? "尚未应用当前选择。" : "连接设置尚未保存。"}保存后才能使用下方识别与匹配操作。</p>}
        </div>}
        <div className="border-t border-edge pt-4 space-y-3">
          <h4 className="font-medium">{cloudSelected ? "云端识别" : "本地识别"}</h4>
          {showProgress && processingPreview}
          {showProgress && statusIsCloud && jevResults}
          <div className="flex flex-wrap gap-2">
            <button className="app-modal-button" disabled={!canRun} onClick={() => void action(() => local.start())}>识别未处理素材</button>
            <button className="app-modal-button" disabled={!canRun} onClick={() => void action(() => local.start({ pendingOnly: false }))}>重新扫描全部图片</button>
            {status?.busy && cloudSelected === statusIsCloud && <button className="app-modal-button" disabled={working} onClick={() => void action(() => local.stop())}>停止</button>}
          </div>
          {!folder && <><label className="flex items-center gap-2">
            <input type="checkbox" checked={status?.enabled ?? false} disabled={!modeReady || working}
              onChange={(e) => void action(() => local.enable(e.target.checked))} />
            自动处理新素材
          </label>
          <p className="text-xs text-muted">自动处理使用当前已应用的分类方式。停止任务也会暂停自动处理。</p></>}
          {folder && <p className="text-xs text-muted">文件夹按需扫描。再次识别会处理新增及内容变更的图片；关闭面板后任务继续。</p>}
          {showProgress && <>
            {status.message && <p role="status" aria-live="polite">{status.message}</p>}
            {status.last_error && <p className="text-xs text-red-400">最近一次未完成原因：{status.last_error}</p>}
            {status.busy && status.phase === "downloading" && <>
              <progress className="w-full" value={status.download_done} max={status.download_total || 1} />
              <p className="text-xs text-muted">{Math.round(status.download_done / 1048576)} / {Math.round(status.download_total / 1048576)} MiB · 可关闭面板，下载继续</p>
            </>}
            {statusIsCloud && status.total > 0 && <p className="text-xs text-muted" aria-label="云端队列进度">Jev 已分析 {status.jev_done} / {status.total} · Cloud 处理中 {status.cloud_running} · 排队 {status.cloud_queued}</p>}
            {status.total > 0 && <p className="text-xs text-muted">已尝试 {status.done} / {status.total} · 成功 {Math.max(0, status.done - status.failed)} · 未完成 {status.failed}</p>}
          </>}
        </div>
      </section>

      <div className="border-t border-edge pt-4 space-y-1">
        <h3 className="font-medium">标签管理</h3>
        <p className="text-xs text-muted">两种方式共用已有标签、说明与人工示例。手动添加的标签会保留，移除的标签不会自动贴回。</p>
      </div>
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
          <button className="app-modal-button" disabled={!canMatch || !name.trim() || !enabled} onClick={() => void action(async () => {
            const id = await local.save(editing, name, description, enabled);
            edit(); await local.start({ tagId: id });
          })}>保存并寻找匹配素材</button>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">已有标签 · {labels.length}</h3>
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
        <p className="text-xs text-muted">{folder ? "先扫描文件夹并选中图片，再将其设为此目录标签的示例或反例。" : "先在素材库多选图片，再将它们设为某个标签的示例或反例。"}模型不会从自己的自动标签中学习偏好。</p>
        {labels.length === 0 && <p className="text-muted py-3">还没有标签。识别图片后会自动发现，也可以先创建。</p>}
        <div className="max-h-64 overflow-y-auto divide-y divide-edge">
          {labels.map((label) => <div key={label.id} className="py-2 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <input type="checkbox" aria-label={`选择标签 ${label.name}`} checked={selectedLabels.has(label.id)} disabled={busy}
                onChange={(e) => setSelectedLabels((current) => {
                  const next = new Set(current);
                  if (e.target.checked) next.add(label.id); else next.delete(label.id);
                  return next;
                })} />
              <button className="text-cold font-medium" disabled={!!folder && !onFilter} title={folder && !onFilter ? "在本机文件中打开该目录后可按标签筛选" : undefined} onClick={() => { if (folder) onFilter?.(label.id); else setSmartFilter(`tag:${label.name}`); onClose(); }}>#{label.name}</button>
              <span className="text-xs text-muted">{label.count} 张{label.enabled ? (cloudActive || label.has_examples ? "" : " · 未设示例，不自动匹配") : " · 已停用自动匹配"}</span>
              <button className="text-xs" onClick={() => edit(label)}>编辑</button>
              <button className="text-xs text-red-400 disabled:opacity-40" aria-label={`删除标签 ${label.name}`} disabled={busy}
                onClick={() => requestDelete([label])}>删除</button>
              <button className="text-xs disabled:opacity-40" disabled={!canMatch || !label.enabled} onClick={() => void action(() => local.start({ tagId: label.id }))}>寻找匹配</button>
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
    <ConfirmDialog open={deleting.length > 0} title={deleting.length === 1 ? `删除标签「${deleting[0].name}」` : `删除 ${deleting.length} 个标签`}
      message={<>
        将从全部素材中移除这些标签，并删除相关示例、排除记录和待匹配任务。素材文件会保留，此操作无法撤销。后续重新识别仍可能生成同名标签。
        {error && <span role="alert" className="block text-red-400">{error}</span>}
      </>}
      confirmLabel={working ? "正在删除…" : "确认删除"} danger confirmDisabled={busy}
      onConfirm={() => void deleteLabels()} onCancel={() => { if (!lock.current) { setDeleting([]); setError(""); } }} />
  </>;
}
