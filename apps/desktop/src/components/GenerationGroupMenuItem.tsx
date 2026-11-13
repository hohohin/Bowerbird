import { useState } from "react";
import { Images, Ungroup } from "lucide-react";
import { api } from "../lib/api";
import { notifyError } from "../lib/notify";
import { reportGalleryMerge } from "../lib/generationGallery";

export function MergeGenerationGroupMenuItem({ assetIds, nodeIds, projectId, onComplete, disabled }: {
  assetIds: string[]; nodeIds?: string[]; projectId: string | null; onComplete: () => void; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  if (new Set(assetIds).size < 2) return null;
  return <button type="button" role="menuitem" className="app-context-item px-2 py-1.5" disabled={disabled || busy}
    onClick={async () => {
      setBusy(true);
      try { const edit = await api.mergeGenerationGalleries({ assetIds, nodeIds, projectId }); reportGalleryMerge(edit, projectId); onComplete(); }
      catch (error) { notifyError(error, "合组失败，请重试"); }
      finally { setBusy(false); }
    }}><Images size={13} />合为组图</button>;
}

export function GenerationGroupMenuItem({ target, onComplete, disabled }: {
  target?: { assetId?: string; groupKey?: string }; onComplete: () => void; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  if (!target) return null;
  return <button type="button" role="menuitem" className="app-context-item px-2 py-1.5" disabled={disabled || busy}
    onClick={async () => {
      setBusy(true);
      try { await api.dissolveGenerationGroup(target); onComplete(); }
      catch (error) { notifyError(error, "解散组合失败，请重试"); }
      finally { setBusy(false); }
    }}><Ungroup size={13} />解散组合</button>;
}
