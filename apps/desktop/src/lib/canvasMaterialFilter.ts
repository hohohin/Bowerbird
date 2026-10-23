import type { MediaFilter } from "./mediaFilter";
import { isVideoPath } from "./videoGeneration";

export type CanvasMaterialFilterState = "all" | "match" | "dim";

export function canvasMaterialFilterState(
  path: string | null, generated: boolean, source: string | null, media: MediaFilter,
): CanvasMaterialFilterState {
  const generatedFilter = source === "source:generated" ? true : source === "source:!generated" ? false : null;
  if (generatedFilter === null && media === null) return "all";
  return (generatedFilter === null || generated === generatedFilter)
    && (media === null || isVideoPath(path) === (media === "video")) ? "match" : "dim";
}
