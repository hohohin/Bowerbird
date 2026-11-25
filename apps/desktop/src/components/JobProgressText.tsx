import { generationProgressLabel } from "../lib/generationProgress";
import { useStore } from "../store";

export function JobProgressText({ jobId, detailOf }: {
  jobId?: string;
  detailOf?: string;
}) {
  const text = useStore(state => {
    const label = generationProgressLabel(jobId ? state.genJobs[jobId] : undefined);
    return detailOf && ["生成视频", "正在生成图像", detailOf].includes(label) ? "" : label;
  });
  if (!text) return null;
  return detailOf ? <small>{text}</small> : text;
}
