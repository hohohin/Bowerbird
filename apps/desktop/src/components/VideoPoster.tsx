import { useState, type ImgHTMLAttributes } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invalidateVideoPoster, useVideoPoster } from "../lib/videoPoster";
import { useMediaVisibility } from "../lib/useMediaVisibility";

const placeholder = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" rx="6" fill="#334155"/><path d="M70 29 L95 45 L70 61 Z" fill="#cbd5e1"/></svg>')}`;

export function VideoPoster({ path, poster, alt = "视频", onError, ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  path?: string | null; poster?: string | null;
}) {
  const { ref, visible } = useMediaVisibility<HTMLImageElement>();
  const [failed, setFailed] = useState<{ path: typeof path; poster: typeof poster; repaired?: boolean }>();
  // A carousel may reuse this component; returning to a video gets a fresh repair attempt.
  if (failed && (failed.path !== path || failed.poster !== poster)) setFailed(undefined);
  const repairing = failed !== undefined && failed.path === path && failed.poster === poster;
  const resolved = useVideoPoster(path, repairing ? null : poster, repairing, visible);
  const source = visible && resolved ? (resolved.startsWith("data:") ? resolved : `${convertFileSrc(resolved)}${repairing ? "?posterRepair=1" : ""}`) : placeholder;
  return <img {...props} ref={ref} alt={alt} src={repairing && failed?.repaired ? placeholder : source} onError={event => {
    // A saved path is not proof the file still exists (moved library, lost/corrupt cache).
    // Rebuild once; a failed repair must show a real placeholder, never a broken image.
    if (source !== placeholder) {
      if (!repairing && path && resolved) invalidateVideoPoster(path, resolved);
      setFailed({ path, poster, repaired: repairing });
    }
    onError?.(event);
  }} />;
}
