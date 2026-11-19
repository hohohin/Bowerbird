import { ContextMenu } from "./ContextMenu";
import { CanvasImage } from "./CanvasImage";
import { VideoPoster } from "./VideoPoster";
import { AudioWaveformThumbnail } from "./AudioWaveform";
import { workflowAssetMedia } from "../lib/workflowCanvasCapabilities";
import type { Asset } from "../lib/types";

export interface DisconnectChoice { key: string; label: string; detail: string; assetIds: string[]; disabled: boolean; disconnect: () => void }
export function WorkflowDisconnectMenu({ x, y, choices, assets, onClose }: { x: number; y: number; choices: DisconnectChoice[]; assets: Asset[]; onClose: () => void }) {
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return <ContextMenu x={x} y={y} label="选择要断开的连线" className="workflow-disconnect-menu" onClose={onClose}>
    <div className="app-context-label">选择要断开的连线</div>
    {choices.map(choice => {
      const media = choice.assetIds.flatMap(id => {
        const asset = byId.get(id), kind = workflowAssetMedia(asset);
        return asset && kind ? [{ asset, kind }] : [];
      });
      const filenames = media.map(({ asset }) => asset.name).filter(name => name !== choice.label);
      const detail = [choice.detail, filenames.join("、"), choice.disabled ? "运行中" : ""].filter(Boolean).join(" · ");
      return <button className="app-context-item px-2 py-1.5" key={choice.key} role="menuitem" data-workflow-disconnect-choice={choice.key}
        disabled={choice.disabled} title={`${choice.label} · ${detail}`} onClick={() => { onClose(); choice.disconnect(); }}>
        {!!media.length && <span className="workflow-disconnect-media" aria-hidden="true">
          {media.slice(0, 3).map(({ asset, kind }) => <span key={asset.id} data-workflow-disconnect-asset={asset.id}>
            {kind === "audio" ? <AudioWaveformThumbnail asset={asset} /> : kind === "video"
              ? <VideoPoster path={asset.store_path} poster={asset.thumb_path} alt="" draggable={false} />
              : <CanvasImage path={asset.store_path} thumbPath={asset.thumb_path} sourceWidth={asset.width} sourceHeight={asset.height} alt="" draggable={false} />}
          </span>)}
          {media.length > 3 && <small>+{media.length - 3}</small>}
        </span>}
        <span className="workflow-disconnect-source"><b>{choice.label}</b><small className="context-menu-reason">{detail}</small></span><span aria-hidden="true">断开</span>
      </button>;
    })}
  </ContextMenu>;
}
