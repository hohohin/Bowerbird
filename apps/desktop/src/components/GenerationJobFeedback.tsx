import { memo, type ReactNode } from "react";
import { genJobWithStream, useStore } from "../store";
import { generationProgressLabel } from "../lib/generationProgress";

export function useGenerationJob(jobId?: string | null) {
  const job = useStore(state => jobId ? state.genJobs[jobId] : undefined);
  const stream = useStore(state => jobId ? state.genJobStreams[jobId] : undefined);
  return genJobWithStream(job, stream);
}

export const GenerationJobProgress = memo(function GenerationJobProgress({ jobId, detailFor }: { jobId?: string; detailFor?: string }) {
  const label = useStore(state => generationProgressLabel(jobId ? genJobWithStream(state.genJobs[jobId], state.genJobStreams[jobId]) : undefined));
  if (detailFor) return ["生成视频", "正在生成图像", detailFor].includes(label) ? null : <small>{label}</small>;
  return label;
});

export const GenerationJobPreview = memo(function GenerationJobPreview({ jobId, turnKey, children }: { jobId?: string; turnKey?: string; children: ReactNode }) {
  const src = useStore(state => {
    const job = jobId ? genJobWithStream(state.genJobs[jobId], state.genJobStreams[jobId]) : undefined;
    return job?.running && job.preview?.turnKey === turnKey ? job.preview?.dataUrl : undefined;
  });
  return src ? <img src={src} alt="本轮生成预览" draggable={false} className="mx-auto block max-h-[230px] max-w-full object-contain" /> : children;
});
