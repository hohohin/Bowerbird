import { useState } from "react";
import { Pencil, X } from "lucide-react";
import type { WorkflowNode } from "../lib/canvasWorkflow";
import { nextDailyTrigger } from "../lib/workflowTriggerSchedule";

function localDateTime(at: number) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function WorkflowTriggerSchedule({ schedule, mode, disabled, onChange }: {
  schedule: WorkflowNode["triggerSchedule"]; mode: "daily" | "once"; disabled: boolean; onChange: (schedule: WorkflowNode["triggerSchedule"]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const daily = mode === "daily";
  const [time, setTime] = useState("");
  const [error, setError] = useState("");
  const clockTime = schedule ? schedule.dailyAt ?? localDateTime(schedule.at).slice(11) : "--:--";
  const scheduleLabel = schedule?.dailyAt ? `每天 ${schedule.dailyAt}` : schedule ? new Date(schedule.at).toLocaleString("zh-CN") : "设置定时";
  const edit = () => {
    const dateTime = localDateTime(Math.max(schedule?.at ?? 0, Date.now() + 60000));
    setValue(dateTime); setTime(schedule?.dailyAt ?? dateTime.slice(11)); setError(""); setEditing(true);
  };
  return <div className="workflow-trigger-schedule" data-schedule-status={schedule?.status ?? "off"} onPointerDown={event => event.stopPropagation()}>
    {!editing ? <>
      <div className="workflow-schedule-display">
        <button className="workflow-schedule-clock" type="button" aria-label={schedule ? "修改" : "设置"} title={schedule ? `修改定时 · 下次执行：${new Date(schedule.at).toLocaleString("zh-CN")}` : "设置定时执行"} disabled={disabled} onClick={edit}>
          {schedule ? <time className="workflow-schedule-digits" dateTime={new Date(schedule.at).toISOString()} aria-label={scheduleLabel}>{clockTime}</time>
            : <span className="workflow-schedule-digits">{clockTime}</span>}
          <Pencil size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
        {schedule?.status === "armed" && <button className="workflow-schedule-cancel" type="button" aria-label="取消定时" title="取消定时" disabled={disabled} onClick={() => onChange(undefined)}><X size={16} /></button>}
      </div>
      <div className="workflow-schedule-meta" role="status">
        {schedule && !daily && <span>{new Date(schedule.at).toLocaleDateString("zh-CN")}</span>}
        {schedule && <span className="workflow-schedule-status">{({ armed: "待触发", fired: "已触发", missed: "已错过", failed: "启动失败" })[schedule.status]}</span>}
      </div>
    </> : <>
      <label>{daily ? "每天执行时间" : "执行时间"}<input aria-label="定时执行时间" type={daily ? "time" : "datetime-local"} value={daily ? time : value} min={daily ? undefined : localDateTime(Date.now())} step={60} disabled={disabled}
        onChange={event => { if (daily) setTime(event.target.value); else setValue(event.target.value); setError(""); }} /></label>
      {error && <p className="workflow-schedule-error" role="alert">{error}</p>}
      <div className="workflow-schedule-actions">
        <button type="button" disabled={disabled} onClick={() => {
          const at = daily ? nextDailyTrigger(time, Date.now()) : new Date(value).getTime();
          if (!Number.isFinite(at) || at <= Date.now()) { setError(daily ? "请选择每天执行的时间" : "请选择未来的日期和时间"); return; }
          onChange({ id: crypto.randomUUID(), at, ...(daily ? { dailyAt: time } : {}), status: "armed" }); setEditing(false);
        }}>确定</button>
        <button type="button" onClick={() => { setEditing(false); setError(""); }}>取消</button>
      </div>
      <p className="workflow-hint">按本机时间执行，需保持应用运行。</p>
    </>}
  </div>;
}
