import type { ImgHTMLAttributes } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useVideoPoster } from "../lib/videoPoster";

const placeholder = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" rx="6" fill="#334155"/><path d="M70 29 L95 45 L70 61 Z" fill="#cbd5e1"/></svg>')}`;

export function VideoPoster({ path, poster, alt = "视频", ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  path?: string | null; poster?: string | null;
}) {
  const resolved = useVideoPoster(path, poster);
  return <img {...props} alt={alt} src={resolved ? (resolved.startsWith("data:") ? resolved : convertFileSrc(resolved)) : placeholder} />;
}
