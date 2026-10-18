import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { artboardCompositionPrompt, type ArtboardComposition } from "../lib/canvasArtboard";
import { renderArtboardComposition } from "../lib/artboardRaster";
import type { Asset } from "../lib/types";
import { ModalShell } from "./ModalShell";
import { ProviderSelect } from "./creation/ProviderSelect";

export function CanvasArtboardDialog({ composition, onClose, onSubmit }: {
  composition: ArtboardComposition;
  onClose: () => void;
  onSubmit: (prompt: string, instruction: string, references: Asset[], provider: string) => Promise<void>;
}) {
  const [instruction, setInstruction] = useState("");
  const [raster, setRaster] = useState<Awaited<ReturnType<typeof renderArtboardComposition>> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const prepared = useRef<Asset[] | null>(null);
  const [provider, setProvider] = useState(useStore.getState().activeGenProvider);
  const codexHealth = useStore(s => s.codexHealth), dreaminaHealth = useStore(s => s.dreaminaHealth);
  const cloudAuth = useStore(s => s.cloudAuth), cloudEntitlement = useStore(s => s.cloudEntitlement);
  const cloudAvailable = cloudAuth?.cloud_available ?? false;
  useEffect(() => {
    let current = true;
    renderArtboardComposition(composition).then(value => { if (current) setRaster(value); })
      .catch(reason => { if (current) setError(String(reason)); });
    return () => { current = false; };
  }, [composition]);
  async function submit() {
    if (!raster || !instruction.trim() || submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      // Reuse prepared files after a rejected submission; no library assets are created.
      prepared.current ??= await Promise.all([
        api.saveAnnotationTemp({ dataUrl: raster.preview, fileName: "画板拼放预览" }),
        api.saveAnnotationTemp({ dataUrl: raster.marked, fileName: "画板位置红框" }),
      ]);
      await onSubmit(artboardCompositionPrompt(composition, instruction), instruction.trim(), [...prepared.current, ...composition.references], provider);
      onClose();
    } catch (reason) { setError(String(reason)); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <ModalShell title="合成画板中的内容" width="lg" onClose={onClose} preventClose={busy}
    description={`${composition.width} × ${composition.height} · ${composition.images.length} 个素材实例 · 按当前画板位置合成`}
    footer={<><ProviderSelect value={provider} onChange={setProvider} codexHealth={codexHealth} dreaminaHealth={dreaminaHealth}
      cloudAvailable={cloudAvailable} cloudAuth={cloudAuth} cloudEntitlement={cloudEntitlement} />
      <button type="button" className="app-modal-button is-primary" disabled={busy || !raster || !instruction.trim()} onClick={() => void submit()}>{busy ? "正在提交…" : "开始合成"}</button></>}>
    <div className="canvas-artboard-previews">
      {raster ? <><figure><img src={raster.preview} alt="画板拼放预览" /><figcaption>拼放效果</figcaption></figure>
        <figure><img src={raster.marked} alt="基底与编号红框" /><figcaption>位置标注（仅定位辅助）</figcaption></figure></> : <p>正在读取原图并制作位置参考…</p>}
    </div>
    <label className="canvas-artboard-prompt">合成提示词<textarea data-modal-autofocus value={instruction} disabled={busy}
      onChange={event => setInstruction(event.target.value)} placeholder="例如：给人物戴上耳饰，保持人物和背景不变" rows={3} /></label>
    <p className="text-xs text-muted">发送范围内独立图片的拼放图、编号红框图及对应原图，附带位置、尺寸和层叠顺序。越界部分裁切；原图与画板保留，结果进入新的生成会话。素材组请先解散，文字卡片和视频不参与合成。</p>
    {error && <p role="alert" className="mt-2 text-sm text-red-400">{error}</p>}
  </ModalShell>;
}
