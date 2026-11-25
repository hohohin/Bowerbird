import { createRoot } from "react-dom/client";
import { ComfyEnvironmentControl } from "../../../src/components/ComfyVideoCard";
import { DEFAULT_COMFY_VIDEO, type ComfyVideoMode } from "../../../src/lib/comfyVideo";

export function mountComfyEnvironment(host: HTMLElement, composer: boolean, mode?: ComfyVideoMode) {
  createRoot(host).render(<ComfyEnvironmentControl node={{ comfyVideo: { ...DEFAULT_COMFY_VIDEO, mode } }}
    disabled={false} onChange={() => {}} composer={composer} />);
}
