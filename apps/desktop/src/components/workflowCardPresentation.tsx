import { useCallback } from "react";
import { AudioLines, CalendarClock, CheckCheck, Clapperboard, Images, List, MousePointer2, Palette, Repeat2, Sparkles, Timer, Workflow } from "lucide-react";
import type { WorkflowNode } from "../lib/canvasWorkflow";
import { comfyVideoMode, DEFAULT_COMFY_VIDEO } from "../lib/comfyVideo";
import { ComfyEnvironmentControl, type ComfyEnvironmentState } from "./ComfyVideoCard";

function AgentCardIcon({ size }: { size: number }) {
  return <svg className="agent-card-icon" xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 1024 1024">
    <path fill="#1296db" d="M788.96 795.208c3.288-1.72 6.536-3.504 9.76-5.344 8.144-5.104 16.528-9.944 24.408-15.44A319.936 319.936 0 0 0 960 512c0-176.728-143.272-320-320-320H384C207.272 192 64 335.272 64 512s143.408 316.936 320 324c100 4 112 4 192-4v80l72.944-40L672 859.36 788.96 795.2zM225.616 670.4q-32.8-32.8-49.88-75.936Q160 554.72 160 512q0-42.72 15.728-82.456 17.072-43.128 49.88-75.936 32.8-32.8 75.936-49.88Q341.28 288 420 288h200q42.72 0 102.456 15.728 43.128 17.072 75.936 49.88 32.8 32.8 49.88 75.936Q864 469.28 864 512q0 55.424-25.84 104.448C802.056 684.936 664.688 746.944 600 782.416V736c-95.96 14.928-205.128 21.216-298.456-15.728Q258.416 703.2 225.608 670.4zM440 420v120a36 36 0 1 0 72 0v-120a36 36 0 1 0-72 0z m224 0v120a36 36 0 1 0 72 0v-120a36 36 0 1 0-72 0z" />
  </svg>;
}

export const WORKFLOW_CARD_PRESENTATION = {
  instruction: { icon: List, code: "CMD", title: "指令处理" },
  generation: { icon: Images, code: "GEN", title: "图片生成" },
  agent: { icon: AgentCardIcon, code: "AGT", title: "Agent" },
  loop: { icon: Repeat2, code: "LOOP", title: "循环处理" },
  "visual-profile": { icon: Palette, code: "VIS", title: "视觉规范" },
  trigger: { icon: Timer, code: "TRG", title: "触发器" },
  director3d: { icon: Clapperboard, code: "3D", title: "3D 导演台" },
  voice: { icon: AudioLines, code: "VOX", title: "角色声音" },
  "comfy-video": { icon: Clapperboard, code: "VID", title: "视频生成" },
  skill: { icon: Sparkles, code: "MOD", title: "技能卡片" },
  planner: { icon: Sparkles, code: "MOD", title: "工作流助手" },
  text: { icon: Workflow, code: "MOD", title: "工作流" },
};
export function comfyCheckKey(node: WorkflowNode) {
  return JSON.stringify([node.id, node.comfyVideo?.endpoint ?? DEFAULT_COMFY_VIDEO.endpoint, comfyVideoMode(node.comfyVideo)]);
}

export function CardComfyEnvironment({ node, disabled, onChange, onStatus }: {
  node: WorkflowNode; disabled: boolean; onChange: (changes: Partial<WorkflowNode>) => void;
  onStatus: (key: string, message: string | null) => void;
}) {
  const key = comfyCheckKey(node);
  const report = useCallback((result: ComfyEnvironmentState) => onStatus(key, result.ready ? null : result.message), [key, onStatus]);
  return <ComfyEnvironmentControl node={node} disabled={disabled} onChange={onChange} onStatusChange={report} />;
}
export const TRIGGER_MODES = [
  { id: "manual", label: "手动点击", icon: MousePointer2 },
  { id: "daily", label: "每天定时", icon: CalendarClock },
  { id: "once", label: "一次定时", icon: Timer },
  { id: "completion", label: "上游完成", icon: CheckCheck },
] as const;

export function WindingKey({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 10C9 2 2 4 3 8s6 5 9 2Zm0 0c3-8 10-6 9-2s-6 5-9 2ZM12 10v10m-3 0h6m-3-4h3" />
  </svg>;
}
