import { AudioLines, Clapperboard, Film, Images } from "lucide-react";
import { CanvasToolGroup } from "./CanvasToolGroup";

export type CanvasToolboxTool = "replication" | "comfy-video" | "voice" | "video-to-doc";

export function CanvasToolbox({
  workflowReady, pro, canUseLocalVideo, isTestAccount, active, remembered, onTool,
}: {
  workflowReady: boolean;
  pro: boolean;
  canUseLocalVideo: boolean;
  isTestAccount: boolean;
  active: string;
  remembered?: string;
  onTool: (tool: CanvasToolboxTool) => void;
}) {
  return <CanvasToolGroup<CanvasToolboxTool> group="toolbox" label="工具箱"
    active={active} remembered={remembered} onTool={onTool} sections={[{ tools: [
      { id: "replication", label: "视频复刻工具", icon: Clapperboard },
      { id: "comfy-video", label: "本地 H3 视频", icon: Film, locked: !canUseLocalVideo, disabled: !workflowReady && canUseLocalVideo },
      { id: "voice", label: "角色声音", icon: AudioLines, locked: !pro, disabled: !workflowReady && pro },
      ...(isTestAccount ? [{ id: "video-to-doc" as const, label: "视频转图文", icon: Images }] : []),
    ] }]} />;
}
