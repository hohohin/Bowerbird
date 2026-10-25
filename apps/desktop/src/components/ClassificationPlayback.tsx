import { userErrorMessage } from "../lib/userError";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ClassificationResult, LocalClassificationStatus } from "../lib/localClassification";
import { appendClassificationFloats, type ClassificationFloat } from "../lib/classificationFloats";
import "./ClassificationPlayback.css";

function Picture({ asset, pending = false }: { asset: ClassificationResult["asset"]; pending?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  return <div className="classification-playback-picture">
    {asset.thumb_path && failed !== asset.thumb_path
      ? <img src={convertFileSrc(asset.thumb_path)} alt={`${pending ? "正在处理" : "分类结果"}：${asset.name}`} onError={() => setFailed(asset.thumb_path)} />
      : <div className="classification-playback-placeholder"><ImageIcon size={22} aria-hidden="true" /><span>暂无缩略图</span></div>}
  </div>;
}

/** Read-only visual buffer. No IPC, acknowledgements or classification scheduling. */
export function ClassificationPlayback({ status }: { status: LocalClassificationStatus | null }) {
  const seen = useRef<{ run: string; sequence: number; handoff: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<ClassificationFloat[]>([]);
  const [processing, setProcessing] = useState<ClassificationResult["asset"][]>([]);
  const shown = !!status && (status.busy || !!status.message || !!visible.length);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const resize = () => element.style.setProperty("--stage-width", `${element.clientWidth}px`);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown]);
  useEffect(() => {
    if (!status) {
      seen.current = null; setVisible([]); setProcessing([]);
      return;
    }
    const run = status.run_id ?? "";
    const reset = seen.current?.run !== run;
    const handoffs = seen.current
      ? (status.recent_cloud_handoffs ?? []).filter(asset => asset.position > (reset ? 0 : seen.current!.handoff))
      : [];
    setProcessing(previous => {
      if (!status.busy) return [];
      const completed = new Set((status.recent_results ?? []).map(result => result.asset.id));
      const candidates = reset ? [] : previous;
      const observed = [...candidates, ...handoffs.filter(asset => !candidates.some(candidate => candidate.id === asset.id))];
      const next = status.current_asset
        ? [...observed.filter(asset => asset.id !== status.current_asset!.id), status.current_asset]
        : observed;
      return next.filter(asset => !completed.has(asset.id)).slice(-128);
    });
    if (!seen.current) {
      // Opening the panel observes from now on; historical results aren't replayed.
      seen.current = { run, sequence: status.done, handoff: status.jev_done };
      return;
    }
    const changed = seen.current.run !== run;
    const after = changed ? 0 : seen.current.sequence;
    const incoming = (status.recent_results ?? []).filter(result => result.sequence > after);
    seen.current = { run, sequence: Math.max(after, status.done), handoff: Math.max(changed ? 0 : seen.current.handoff, status.jev_done) };
    if (changed || incoming.length || handoffs.length) {
      const now = performance.now();
      setVisible(previous => appendClassificationFloats(changed ? [] : previous, incoming, now, handoffs));
    }
  }, [status]);
  useEffect(() => {
    if (!visible.length) return;
    // Each picture owns its lifetime; new completions never extend older motion.
    const timer = window.setTimeout(() => {
      const now = performance.now();
      setVisible(previous => previous.filter(item => item.expiresAt > now));
    }, Math.max(0, Math.min(...visible.map(item => item.expiresAt)) - performance.now()) + 20);
    return () => window.clearTimeout(timer);
  }, [visible]);
  if (!status || (!status.busy && !status.message && !visible.length)) return null;
  const current = status.busy ? status.current_asset ?? (status.cloud_running ? processing[0] : null) : null;
  const cloudCurrent = !!current && !status.current_asset;
  return <section className="classification-playback" aria-label="分类动态">
    <div className="classification-playback-meta">
      <span>{status.busy ? "分类进行中" : "分类结果"} <span className="classification-playback-count">{status.done} / {status.total}</span></span>
    </div>
    <div ref={stage} className="classification-playback-stage" aria-label="分类动画与当前进度">
    <div className="classification-playback-air" aria-label="上浮的分类结果">
      {visible.map(({ key, motion, result: item, lane, x, tilt, drift, startY, duration }) => <article key={`${status.run_id}:${key}`}
        className={`classification-playback-slot is-${motion}`}
        style={{ "--float-x": x, "--float-tilt": `${tilt}deg`, "--float-drift": `${drift}px`, "--float-y": `${startY}px`, "--float-duration": `${duration}ms` } as CSSProperties}
        data-lane={lane} data-sequence={item.sequence} data-motion={motion} data-kind={key.startsWith("cloud:") ? "handoff" : "result"} aria-label={`${motion === "rise" ? "分类结果" : "移出待匹配素材"}：${item.asset.name}`}>
        <div className="classification-playback-card">
          <Picture asset={item.asset} />
          <div className="classification-playback-tags" aria-label="本图分类标签">
            {item.tags.map((tag, i) => <span key={tag} className="classification-playback-tag" title={tag}
              style={{ "--tag-delay": `${180 + i * 70}ms`, "--tag-angle": `${i % 2 ? 3 : -3}deg` } as CSSProperties}>
              <i aria-hidden="true" />{tag.replace(/^#/, "")}
            </span>)}
          </div>
        </div>
      </article>)}
    </div>
    <div className="classification-playback-dock" aria-label="当前素材与完成进度">
      <div className="classification-playback-current" aria-label={current ? "当前处理素材" : undefined}>
        <div className="classification-playback-stack">
          {current ? <Picture asset={current} pending /> : <div className="classification-playback-picture"><ImageIcon size={22} aria-hidden="true" /></div>}
        </div>
        <div className="classification-playback-current-copy">
          <div className="classification-playback-heading">
            {status.busy && <LoaderCircle size={14} className="classification-playback-spinner" aria-hidden="true" />}
            {current ? cloudCurrent ? "Cloud 补标签中" : "正在分类" : status.busy ? "等待分类结果" : "本轮处理结束"}
          </div>
          <p className="classification-playback-name">{current?.name ?? userErrorMessage(status.message, status.busy ? "正在分类…" : status.last_error ? "本轮分类未完成，请稍后重试。" : "本轮处理结束")}</p>
          {current && <p className="classification-playback-hint">{cloudCurrent ? "正在补充分类标签" : `正在分析 · 第 ${current.position} / ${status.total} 张`}</p>}
        </div>
        <span className="classification-playback-count">已处理 {status.done} / {status.total}</span>
      </div>
    <div className="classification-playback-track" role="progressbar" aria-label="分类进度" aria-valuemin={0} aria-valuemax={status.total || 1} aria-valuenow={status.done}>
      <span style={{ transform: `scaleX(${status.total ? Math.min(1, status.done / status.total) : 0})` }} />
    </div>
    </div>
    </div>
    {!status.busy && <p className="classification-playback-summary" role="status">{userErrorMessage(status.message, status.last_error ? "本轮分类未完成，请稍后重试。" : "本轮处理结束")}</p>}
    {status.busy && status.run_id === undefined && <p className="classification-playback-summary">重启应用后可展示完整分类结果动画，当前分类继续进行。</p>}
    {status.last_error && <p className="classification-playback-error" role="alert">最近未完成原因：{userErrorMessage(status.last_error, "部分素材分类未完成，请稍后重试。")}</p>}
  </section>;
}
