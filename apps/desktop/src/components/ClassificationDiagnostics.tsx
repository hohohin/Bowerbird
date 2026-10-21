import type { LocalClassificationStatus } from "../lib/localClassification";

const names: Record<string, string> = {
  prepare: "准备图片", judge: "Jev 匹配", request: "等待请求响应", response: "解析响应",
  backoff: "Cloud 限流等待", queued: "Cloud 排队", discover: "Cloud 补标签",
  save: "保存标签", complete: "已保存", failed: "失败", cancelled: "已停止",
};
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

/** No independent polling or control APIs: consumes the existing status snapshot. */
export function ClassificationDiagnostics({ status }: { status: LocalClassificationStatus }) {
  const rows = status.diagnostics ?? [];
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({
      run_id: status.run_id, captured_at: new Date().toISOString(),
      progress: { done: status.done, total: status.total, failed: status.failed, cloud_running: status.cloud_running, cloud_queued: status.cloud_queued },
      diagnostics: rows,
    }, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = "classification-diagnostics.json"; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <details className="classification-diagnostics">
    <summary>分类进度诊断 <span>仅开发 / 测试</span></summary>
    <p>只读采样，不影响分类。保留本轮最近 128 张；展开单张查看各阶段耗时。请求等待包含网络、认证和服务端处理，不能仅凭等待时间判断为网络故障。</p>
    <div className="classification-diagnostics-toolbar">
      <span>已处理 {status.done} / {status.total} · Cloud 处理中 {status.cloud_running} · 排队 {status.cloud_queued}</span>
      <button type="button" className="app-modal-button" onClick={download} disabled={!rows.length}>导出诊断</button>
    </div>
    {!rows.length && <p>{status.diagnostics === undefined ? "当前后端未提供诊断数据；更新开发后端后，新分类任务会记录耗时。" : "等待新分类任务开始记录。"}</p>}
    <div className="classification-diagnostics-rows">
      {[...rows].reverse().map(row => {
        const last = row.steps[row.steps.length - 1];
        return <details key={row.id} className="classification-diagnostics-row">
          <summary><span title={row.name}>{row.name}</span><strong>{names[last?.stage ?? ""] ?? last?.stage}</strong><time>{seconds(row.elapsed_ms)}</time></summary>
          {last && !row.finished && <p>当前阶段 {seconds(row.elapsed_ms - last.at_ms)} · {last.detail}</p>}
          <ol>{row.steps.map((step, i) => <li key={i}>
            <span>{names[step.stage] ?? step.stage} · {step.detail}</span>
            <time>{seconds((row.steps[i + 1]?.at_ms ?? row.elapsed_ms) - step.at_ms)}</time>
          </li>)}</ol>
        </details>;
      })}
    </div>
  </details>;
}
