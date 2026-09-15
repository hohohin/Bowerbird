import { ShieldCheck, ShieldQuestion } from "lucide-react";
import { agentApprovalMode, agentApprovalScope } from "../lib/cloudAgentApproval";
import type { CloudAgentRunRecord } from "../lib/types";
import { useStore } from "../store";

export function AgentApprovalToggle({ run }: { run: Pick<CloudAgentRunRecord, "projectId" | "threadId"> }) {
  const mode = useStore((state) => agentApprovalMode(run, state.agentApprovalModes));
  const setMode = useStore((state) => state.setAgentApprovalMode);
  if (!agentApprovalScope(run)) return null;
  const automatic = mode === "auto";
  const Icon = automatic ? ShieldCheck : ShieldQuestion;
  return (
    <button
      type="button"
      role="switch"
      aria-label="自行批准"
      aria-checked={automatic}
      title={automatic ? "当前会话自动批准执行与修订计划，并自动接受结果入库；点击切回请求批准" : "当前会话执行与入库前请求批准；点击允许自行批准并自动入库"}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${automatic ? "border-lime/40 bg-lime/10 text-lime" : "border-edge text-muted hover:text-ink"}`}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        setMode(run, automatic ? "request" : "auto");
      }}
    >
      <Icon size={13} />{automatic ? "自行批准" : "请求批准"}
    </button>
  );
}
