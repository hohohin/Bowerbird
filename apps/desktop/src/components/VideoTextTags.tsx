import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import type { AssetTag } from "../lib/types";
import { userErrorMessage } from "../lib/userError";
import { useStore } from "../store";
import { BcoinAmount } from "./BcoinAmount";
import { ModalShell } from "./ModalShell";

interface VideoTextTagStatus {
  hasTranscript: boolean;
  hasDescription: boolean;
  available: boolean;
  credits: number | null;
}

interface Props {
  assetId: string;
  placement?: "detail" | "classification";
  onTagsChanged?: (tags: AssetTag[]) => void;
  onOpenAnalysis?: (view: "analysis" | "transcript") => void;
}

export function VideoTextTags({ assetId, placement = "detail", onTagsChanged, onOpenAnalysis }: Props) {
  const owner = useStore(state => state.cloudAuth?.user_id);
  const [status, setStatus] = useState<VideoTextTagStatus>();
  const [confirmation, setConfirmation] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const token = useRef(0);

  useEffect(() => {
    const request = ++token.current;
    let refreshId = 0;
    const refresh = () => {
      const id = ++refreshId;
      void invoke<VideoTextTagStatus>("video_text_tags_status", { assetId })
        .then(value => { if (token.current === request && id === refreshId) setStatus(value); })
        .catch(reason => {
          if (token.current === request && id === refreshId) {
            setStatus(undefined);
            setError(userErrorMessage(reason, "暂时无法读取视频文本状态。"));
          }
        });
    };
    setStatus(undefined);
    setConfirmation(null);
    setError("");
    setResult("");
    setBusy(false);
    refresh();
    const unlisten = listen("library://assets-changed", refresh).catch(() => undefined);
    window.addEventListener("focus", refresh);
    return () => {
      ++token.current;
      window.removeEventListener("focus", refresh);
      void unlisten.then(remove => remove?.());
    };
  }, [assetId, owner]);

  async function submit(expectedCredits: number) {
    if (busy) return;
    const request = token.current;
    setBusy(true);
    setError("");
    setResult("");
    try {
      await invoke("video_text_tags_start", { assetId, expectedCredits });
      const tags = await api.listAssetTags(assetId);
      if (token.current === request) {
        onTagsChanged?.(tags);
        setResult("视频文本打标签已完成。");
      }
    } catch (reason) {
      if (token.current === request) setError(userErrorMessage(reason, "视频文本打标签失败，请重试。"));
    } finally {
      if (token.current === request) {
        setBusy(false);
        setConfirmation(null);
      }
    }
  }

  const sources = [status?.hasTranscript && "转录文稿", status?.hasDescription && "画面描述"].filter(Boolean);
  const title = placement === "detail" ? "云端打标签" : "视频文本打标签";
  const price = status?.available ? status.credits : null;
  return <section aria-label={title} className={placement === "detail" ? "asset-detail-card space-y-2" : "classification-section space-y-2"}>
    <h3 className="text-xs font-medium text-muted">{title}</h3>
    {status && (sources.length === 0
      ? <>
        <p className="text-xs text-muted">先转录文稿或生成画面描述。</p>
        {onOpenAnalysis && <div className="flex flex-wrap gap-2">
          <button type="button" className="app-button-secondary" onClick={() => onOpenAnalysis("transcript")}>转录文稿</button>
          <button type="button" className="app-button-secondary" onClick={() => onOpenAnalysis("analysis")}>画面分析</button>
        </div>}
      </>
      : price !== null
        ? <button type="button" className="app-button-primary" disabled={busy} onClick={() => setConfirmation(price)}>
          云端打标签 · <BcoinAmount amount={price}/>
        </button>
        : <p className="text-xs text-muted">服务暂未开放。</p>)}
    {error && <p role="alert" className="text-xs text-muted">{error}</p>}
    {result && <p role="status" className="text-xs text-muted">{result}</p>}
    {confirmation !== null && <ModalShell title="确认云端打标签" width="sm" preventClose={busy} onClose={() => setConfirmation(null)}
      footer={<>
        <button type="button" className="app-modal-button" disabled={busy} onClick={() => setConfirmation(null)}>取消</button>
        <button type="button" className="app-modal-button is-primary" disabled={busy || confirmation !== price}
          onClick={() => void submit(confirmation)}>{busy ? "正在打标签…" : "确认"}</button>
      </>}>
      <p>仅发送{sources.join("、")}的正文与标签定义 · <BcoinAmount amount={confirmation}/></p>
    </ModalShell>}
  </section>;
}
