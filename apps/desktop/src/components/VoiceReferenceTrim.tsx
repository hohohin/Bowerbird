import { useEffect, useRef, useState } from "react";
import { Play, Pause } from "lucide-react";
import { AudioWaveform } from "./AudioWaveform";
import { MediaTrimTimeline } from "./MediaTrimTimeline";
import { requestAudioWaveform } from "../lib/audioPreviewPeaks";
import { playAudioPreview, stopAudioPreview, audioPreviewKey, audioPreviewPosition, subscribeAudioPreview, audioPreviewSnapshot } from "../lib/audioPreview";
import { voiceClipRange } from "../lib/voiceStudioDraft";
import type { Asset } from "../lib/types";
import { userErrorMessage } from "../lib/userError";

export function VoiceReferenceTrim({ asset, start, end, onChange, disabled }: { asset: Asset; start: number; end: number; onChange: (value: { start: number; end: number }) => void; disabled: boolean }) {
  const [duration, setDuration] = useState(asset.duration ?? 0), [version, setVersion] = useState(""), [error, setError] = useState("");
  const [time, setTime] = useState(start), [playing, setPlaying] = useState(false); const owner = useRef({});
  const path = asset.store_path ?? "", key = audioPreviewKey({ assetId: asset.id, path, sourceVersion: version });
  useEffect(() => requestAudioWaveform({ key: JSON.stringify([asset.id, path, asset.file_mtime ?? asset.created_at ?? 0, undefined]), assetId: asset.id }, result => {
    if (result.data) { setDuration(result.data.duration); setVersion(result.data.sourceVersion); }
    else setError(userErrorMessage(result.error, "录音读取失败，请重新选择"));
  }), [asset.id, path]);
  useEffect(() => { if (duration >= 1 && (!end || end > duration)) onChange({ start: 0, end: Math.min(duration, 12) }); }, [duration, end, onChange]);
  useEffect(() => () => stopAudioPreview(asset.id), [asset.id]);
  useEffect(() => subscribeAudioPreview(key, () => { const state = audioPreviewSnapshot(key); setPlaying(state.phase === "playing" || state.phase === "loading"); if (state.phase === "error") setError(state.error); }), [key]);
  useEffect(() => { stopAudioPreview(asset.id); setPlaying(false); setTime(start); }, [start, end, asset.id]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => { const position = audioPreviewPosition(key); if (!position) return;
      setTime(position.time); if (position.time >= end) { stopAudioPreview(asset.id); setPlaying(false); setTime(start); }
    }, 30); return () => clearInterval(timer);
  }, [playing, key, end, start, asset.id]);
  function play(value = start) { playAudioPreview({ assetId: asset.id, path, sourceVersion: version, duration }, value / duration, true, owner.current); setPlaying(true); }
  return <div className="voice-reference-trim">
    <MediaTrimTimeline duration={duration} start={start} end={end || duration} time={time} minGap={1} maxLength={30} disabled={disabled || !version || duration < 1}
      change={(edge, value) => onChange(voiceClipRange(duration, start, end || duration, edge, value))} seek={value => play(Math.max(start, Math.min(end, value)))}>
      <AudioWaveform assetId={asset.id} path={path} name={asset.name} version={asset.file_mtime ?? asset.created_at ?? 0} interactive={false} />
    </MediaTrimTimeline>
    <div className="voice-studio-row"><button className="app-modal-button" aria-label={playing ? "暂停参考录音" : "试听参考录音"} disabled={!version || duration < 1} onClick={() => { if (playing) { stopAudioPreview(asset.id); setPlaying(false); } else play(); }}>{playing ? <Pause size={15} /> : <Play size={15} />}</button></div>
    {duration > 0 && duration < 1 && <p role="alert">录音不足 1 秒，请换一段录音</p>}{error && <p role="alert">{error}</p>}
  </div>;
}
