import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { localClassification as local, type ClassificationLabel, type LocalClassificationStatus } from "../lib/localClassification";
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

function JevAnswer({ probability, threshold, noMatch = false }: { probability: number | null; threshold: number; noMatch?: boolean }) {
  if (probability === null) return <span className="text-muted">缺少有效结果</span>;
  const options = [
    { name: noMatch ? "是" : "匹配", value: probability },
    { name: noMatch ? "否" : "不匹配", value: 1 - probability },
  ].sort((a, b) => b.value - a.value);
  return <div className="space-y-2">
    {options.map((option, index) => <div key={option.name} className={`flex items-center gap-2 ${index === 0 ? "text-ink" : "text-muted"}`}>
      <span className="min-w-0 flex-1">{option.name}</span>
      <span className="font-mono tabular-nums" title={String(option.value)}>{(option.value * 100).toFixed(2)}%</span>
      <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-cold" aria-hidden="true">
        <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="4" opacity="0.2" />
        <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="4" pathLength="100"
          strokeDasharray={`${option.value * 100} 100`} transform="rotate(-90 10 10)" />
      </svg>
    </div>)}
    <p className="pt-1 text-xs text-muted">判定：{noMatch ? probability >= threshold ? "是" : "否" : probability >= threshold ? "匹配" : "不匹配"}</p>
  </div>;
}

function JevResults({ progress }: { progress: NonNullable<LocalClassificationStatus["jev_progress"]> }) {
  return <section aria-label="Jev 返回结果" className="overflow-hidden rounded-lg border border-edge">
    <div className="space-y-2 p-3">
      <h5 className="font-medium">Jev 返回结果</h5>
      <p className="text-xs text-muted break-all">素材：{progress.asset.name}</p>
      <p className="text-xs" role="status">{progress.message}</p>
      <p className="text-xs text-muted">显示当前或最近一张素材的返回内容。匹配结果在此图全部处理成功后才保存。</p>
      {progress.batches.length === 0 && <p className="text-xs text-muted">暂无 Jev 返回内容</p>}
    </div>
    <div className="max-h-[28rem] overflow-y-auto">
      {progress.batches.map((batch) => <div key={batch.batch} className="border-t border-edge">
        <div className="flex flex-wrap justify-between gap-1 bg-panel2 px-3 py-2 text-xs text-muted">
          <span>第 {batch.batch} 批</span><span>匹配阈值 {(batch.threshold * 100).toFixed(0)}%</span>
        </div>
        <table className="w-full table-fixed text-xs">
          <thead><tr className="border-b border-edge text-left text-muted">
            <th className="w-1/2 px-3 py-3 font-normal">标签与判断说明</th>
            <th className="break-all px-3 py-3 font-normal">{batch.model}</th>
          </tr></thead>
          <tbody>
            {batch.labels.map((label, index) => <tr key={index} className="border-b border-edge align-top">
              <td className="px-3 py-4">
                <p className="break-all font-medium">{label.name}</p>
                <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed text-muted">{label.description || "判断目标图片是否属于此标签"}</p>
              </td>
              <td className="px-3 py-4"><JevAnswer probability={label.probability} threshold={batch.threshold} /></td>
            </tr>)}
            <tr className="align-top">
              <td className="px-3 py-4">
                <p className="font-medium">无已有匹配标签（本批）</p>
                <p className="mt-2 leading-relaxed text-muted">目标图片是否不符合本批任何已有标签？</p>
              </td>
              <td className="px-3 py-4"><JevAnswer probability={batch.no_match} threshold={batch.threshold} noMatch /></td>
            </tr>
          </tbody>
        </table>
        <div className="space-y-2 px-3 pb-3">
          <p className="text-xs text-muted">二元概率：否 = 1 − 是；不代表整图置信度。</p>
          {batch.error && <p className="text-xs text-red-400">本批未采用：{batch.error}</p>}
          <details className="text-xs">
            <summary className="cursor-pointer text-muted">查看 Jev 原始返回（第 {batch.batch} 批）</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-panel2 p-2">{JSON.stringify(batch.response, null, 2)}</pre>
          </details>
        </div>
      </div>)}
    </div>
  </section>;
}

export function LocalClassificationDialog({ onClose }: { onClose: () => void }) {
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
  const showProgress = status && cloudSelected === statusIsCloud && (status.busy || cloudSelected === cloudActive);
  const currentAsset = status?.busy && status.phase === "classifying" ? status.current_asset : null;
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
      if (deleting.some((label) => useStore.getState().smartFilter === `tag:${label.name}`)) setSmartFilter(null);
      setSelectedLabels((current) => new Set([...current].filter((id) => !deleting.some((label) => label.id === id))));
      setLabels((current) => current.filter((label) => !deleting.some((target) => target.id === label.id)));
      setNotice(`已删除 ${deleting.length} 个标签，素材文件已保留。`);
      setDeleting([]);
    });
  }

  return <><ModalShell title="自动分类" width="lg" onClose={onClose} preventClose={deleting.length > 0}
    description="选择分类方式，再识别素材。标签与人工修正由两种方式共用。">
    <div className="space-y-5 text-sm">
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
              <p className="text-xs text-muted">按图片、标签说明和人工示例判断，未设示例的标签也会参与。</p>
            </li>
            <li className="rounded bg-panel2 p-3 space-y-1">
              <p className="font-medium">2. Cloud 补充新标签</p>
              <p className="text-xs text-muted">仅在「无已有匹配标签」时调用豆包，生成 0–3 个新标签，不限定分类方向。</p>
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
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={status?.enabled ?? false} disabled={!modeReady || working}
              onChange={(e) => void action(() => local.enable(e.target.checked))} />
            自动处理新素材
          </label>
          <p className="text-xs text-muted">自动处理使用当前已应用的分类方式。停止任务也会暂停自动处理。</p>
          {showProgress && <>
            {status.message && <p role="status" aria-live="polite">{status.message}</p>}
            {status.last_error && <p className="text-xs text-red-400">最近一次未完成原因：{status.last_error}</p>}
            {status.busy && status.phase === "downloading" && <>
              <progress className="w-full" value={status.download_done} max={status.download_total || 1} />
              <p className="text-xs text-muted">{Math.round(status.download_done / 1048576)} / {Math.round(status.download_total / 1048576)} MiB · 可关闭面板，下载继续</p>
            </>}
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
        <p className="text-xs text-muted">先在素材库多选图片，再将它们设为某个标签的示例或反例。模型不会从自己的自动标签中学习偏好。</p>
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
              <button className="text-cold font-medium" onClick={() => { setSmartFilter(`tag:${label.name}`); onClose(); }}>#{label.name}</button>
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
