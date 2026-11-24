import type { ReactNode } from "react";
import { generationProgressLabel } from "../lib/generationProgress";
import { useStore } from "../store";

export function CanvasGenerationProgress({ jobId }: { jobId?: string }) {
  return <>{useStore(state => generationProgressLabel(jobId ? state.genJobs[jobId] : undefined))}</>;
}

export function CanvasTurnPreview({ jobId, turnKey, children }: { jobId?: string; turnKey?: string | null; children: ReactNode }) {
  const preview = useStore(state => {
    const preview = jobId && state.genJobs[jobId]?.preview;
    return preview && preview.turnKey === turnKey ? preview.dataUrl : null;
  });
  return preview ? <img src={preview} alt="本轮生成预览" draggable={false} className="mx-auto block max-h-[230px] max-w-full object-contain" /> : <>{children}</>;
}
