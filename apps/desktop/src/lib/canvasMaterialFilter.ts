import type { MediaFilter } from "./mediaFilter";
import { mediaType } from "./mediaFilter";

export type CanvasMaterialFilterState = "all" | "match" | "dim";

export function canvasMaterialFilterState(
  path: string | null, generated: boolean, source: string | null, media: MediaFilter,
): CanvasMaterialFilterState {
  const generatedFilter = source === "source:generated" ? true : source === "source:!generated" ? false : null;
  if (generatedFilter === null && media === null) return "all";
  return (generatedFilter === null || generated === generatedFilter)
    && (media === null || mediaType(path) === media) ? "match" : "dim";
}
