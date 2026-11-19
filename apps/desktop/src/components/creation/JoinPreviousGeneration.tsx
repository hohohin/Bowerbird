import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { useStore } from "../../store";
import { generationSessionTitle } from "../../lib/projectActivity";

export function JoinPreviousGeneration({ jobId, projectId, checked, submitting, onChange, onInspect }: {
  jobId: string | null; projectId: string | null; checked: boolean; submitting: boolean;
  onChange: (value: boolean) => void; onInspect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [alignLeft, setAlignLeft] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const checkbox = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const job = useStore(state => jobId ? state.genJobs[jobId] : undefined);
  const available = !!job && job.projectId === projectId;
  useEffect(() => {
    if (!open || !jobId || available) return;
    let current = true;
    setUnavailable(false);
    void useStore.getState().loadGenJobs(jobId).then(() => {
      if (current) setUnavailable(useStore.getState().genJobs[jobId]?.projectId !== projectId);
    });
    return () => { current = false; };
  }, [open, jobId, projectId, available]);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (root.current?.contains(document.activeElement)) checkbox.current?.focus();
      setOpen(false);
    }
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [open]);

  function inspect() {
    if (open) return;
    setAlignLeft((root.current?.getBoundingClientRect().right ?? 0) < 272);
    setOpen(true);
    onInspect();
  }

  const title = generationSessionTitle(job?.turns[0]?.promptRaw || job?.turns[0]?.prompt || job?.lastPrompt || "");
  return <div ref={root} className="composer-join-wrap"
    onPointerEnter={inspect} onPointerLeave={() => { if (!root.current?.contains(document.activeElement)) setOpen(false); }}
    onFocus={inspect} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <label className="composer-join-previous">
      <input ref={checkbox} type="checkbox" checked={checked && !!jobId} disabled={!jobId || submitting}
        aria-describedby={open ? panelId : undefined} onChange={event => onChange(event.target.checked)} />
      <span>并入上个生成</span>
    </label>
    {open && <div id={panelId} className={`composer-join-bubble${alignLeft ? " align-left" : ""}`}>
      <div className="app-popover">
        {available ? <><div className="app-popover-title">上一个生成会话</div>
          <button type="button" className="composer-join-link" aria-label={`打开会话：${title}`}
            onClick={() => { setOpen(false); useStore.getState().openGenerationJob(job.id); }}>
            <span>{title}</span><ArrowUpRight size={15} aria-hidden />
          </button></> : <span role="status">{!jobId ? "当前项目还没有可并入的图片生成" : unavailable ? "暂时无法读取该会话" : "正在读取会话…"}</span>}
      </div>
    </div>}
  </div>;
}
