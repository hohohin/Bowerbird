import { useEffect, useState } from "react";
import { externalFiles } from "./externalFiles";
import { notifyError } from "./notify";

/** Decode HEIC for display while the asset continues to point at its original. */
export function useCompatibleImagePath(path: string | null | undefined) {
  const [resolved, setResolved] = useState<{ original: string; preview: string } | null>(null);
  const needsPreview = !!path && /\.(heic|heif)$/i.test(path);
  useEffect(() => {
    if (!path || !needsPreview) return;
    let current = true;
    externalFiles.media(path).then(preview => {
      if (current) setResolved({ original: path, preview });
    }).catch(error => { if (current) notifyError(error, "无法预览图片，请检查原文件是否可访问"); });
    return () => { current = false; };
  }, [path, needsPreview]);
  return needsPreview ? resolved?.original === path ? resolved.preview : undefined : path ?? undefined;
}
