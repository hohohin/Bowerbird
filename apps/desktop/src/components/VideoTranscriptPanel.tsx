import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { accountEntitlement } from "../lib/entitlement";
import { userErrorMessage } from "../lib/userError";
import { quoteVideoTranscript, refreshVideoTranscriptTiming, startVideoTranscript, useVideoTranscript, type useVideoTranscriptPrice } from "../lib/videoTranscript";
import { VideoTranscriptReader } from "./VideoTranscriptReader";
import { BcoinAmount } from "./BcoinAmount";

export type VideoAnalysisView = "analysis" | "transcript";

export function VideoTranscriptPanel({ assetId, sourceKey, active, durationSeconds, onSeek, onRead, price, mediaKind = "video" }: {
  assetId: string;
  sourceKey: string;
  active: boolean;
  durationSeconds?: number | null;
  onSeek: (time: number) => void;
  onRead?: () => void;
  price: ReturnType<typeof useVideoTranscriptPrice>;
  mediaKind?: "video" | "audio";
}) {
  const auth = useStore(state => state.cloudAuth);
  const owner = auth?.logged_in ? auth.user_id : null;
  const entitlement = useStore(state => accountEntitlement(state.cloudEntitlement, owner));
  const { transcript, error: loadError, update, refresh } = useVideoTranscript(assetId, sourceKey, owner);
  const balances = entitlement?.offline_state === "fresh" ? entitlement.balances : null;
  const balance = balances ? balances.daily + balances.sub + balances.topup : null;
  const insufficient = price.credits !== null && balance !== null && balance < price.credits;
  const mediaLabel = mediaKind === "audio" ? "音频" : "视频";
  const durationLimit = price.maxDurationMs ?? (mediaKind === "audio" ? 7_200_000 : undefined);
  const overLimit = durationSeconds != null && Number.isFinite(durationSeconds) && durationLimit != null
    && durationSeconds * 1000 > durationLimit;
  const [startError, setStartError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [refreshingTiming, setRefreshingTiming] = useState(false);
  const [timingError, setTimingError] = useState<{ owner: string; message: string }>();
  const [lastAttempt, setLastAttempt] = useState<{ owner: string; priceRevision: number }>();
  const panel = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const context = useRef(0);
  const focusPanel = () => panel.current?.focus({ preventScroll: true });
  const priceNeedsRefresh = !submitting && transcript?.status === "interrupted" && !transcript.cloudPending
    && !!lastAttempt && lastAttempt.owner === owner && lastAttempt.priceRevision === price.revision;
  const refreshPrice = price.refresh;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => {
    return () => { context.current++; };
  }, [assetId, sourceKey, active, owner]);
  useEffect(() => {
    if (priceNeedsRefresh) refreshPrice();
  }, [priceNeedsRefresh, refreshPrice]);

  function isCurrent(requestContext: number, expectedOwner: string) {
    const currentAuth = useStore.getState().cloudAuth;
    return mounted.current && context.current === requestContext && !!currentAuth?.logged_in && currentAuth.user_id === expectedOwner;
  }

  async function start(resume: boolean) {
    if (pending.current || !owner || !active) return;
    const expectedCredits = resume ? undefined : price.credits ?? undefined;
    if (!resume && (expectedCredits === undefined || overLimit || insufficient || priceNeedsRefresh)) return;
    const requestContext = context.current;
    if (!isCurrent(requestContext, owner)) return;
    pending.current = true;
    focusPanel();
    setSubmitting(true);
    setStartError("");
    let startInvoked = false;
    try {
      const quote = resume ? undefined : await quoteVideoTranscript(assetId);
      if (!isCurrent(requestContext, owner)) return;
      if (quote?.noAudio) {
        update({ status: "no_audio", text: "", utterances: [] });
        return;
      }
      if (quote && (!quote.chargeRequired || quote.cloudPending)) {
        refresh();
        return;
      }
      if (expectedCredits !== undefined) setLastAttempt({ owner, priceRevision: price.revision });
      startInvoked = true;
      const current = await startVideoTranscript(assetId, owner, expectedCredits, quote);
      if (!isCurrent(requestContext, owner)) return;
      update(current);
      if (current.status === "running") refresh();
    } catch (reason) {
      if (isCurrent(requestContext, owner)) {
        setStartError(userErrorMessage(reason, "转录暂未完成，请检查原件和任务状态后重试。"));
        refresh();
        if (startInvoked && expectedCredits !== undefined) refreshPrice();
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  async function refreshTiming() {
    if (pending.current || !owner || !active || !transcript?.canRefreshTiming) return;
    const requestContext = context.current;
    if (!isCurrent(requestContext, owner)) return;
    pending.current = true;
    focusPanel();
    setRefreshingTiming(true);
    setTimingError(undefined);
    try {
      const completed = await refreshVideoTranscriptTiming(assetId, owner);
      if (isCurrent(requestContext, owner)) update(completed);
    } catch (reason) {
      if (isCurrent(requestContext, owner)) {
        setTimingError({ owner, message: userErrorMessage(reason, "暂时无法补齐字级时间，请稍后重试。") });
      }
    } finally {
      pending.current = false;
      if (mounted.current) setRefreshingTiming(false);
    }
  }

  let content;
  if (loadError) {
    content = <>
      <p role="alert">{userErrorMessage(loadError, "转录状态暂时无法读取，请刷新。")}</p>
      <button type="button" onClick={() => { focusPanel(); refresh(); }}>刷新转录状态</button>
    </>;
  } else if (submitting || transcript?.status === "running") {
    content = <p role="status">{submitting ? "正在准备转录…" : "正在转录，关闭窗口后可回来查看。"}</p>;
  } else if (transcript === undefined) {
    content = <p role="status">正在读取转录文稿…</p>;
  } else if (transcript?.status === "completed") {
    content = onRead ? <>
      <p role="status">已完成转录。</p>
      <button type="button" className="app-button-primary" onClick={onRead}>查看转录文稿</button>
    </> : <>
      <VideoTranscriptReader transcript={transcript} onSeek={onSeek}/>
      {(transcript.canRefreshTiming && owner || timingError?.owner === owner) && <div className="video-analysis-reader-note">
        {timingError && timingError.owner === owner && <p role="alert">{timingError.message}</p>}
        {transcript.canRefreshTiming && owner && <div className="video-analysis-repair">
          <button type="button" className="app-button-secondary" disabled={refreshingTiming || !active}
            onClick={() => void refreshTiming()}>补齐字级时间</button>
          <span role="status">{refreshingTiming ? "正在补齐字级时间…" : "原任务补齐，不消耗 Bcoin"}</span>
        </div>}
      </div>}
    </>;
  } else if (transcript?.status === "no_audio" || transcript?.status === "no_speech") {
    const noAudio = mediaKind === "audio" ? "此音频没有可用音轨。" : "此视频没有音轨。";
    content = <p role="status">{transcript.status === "no_audio" ? noAudio : "未识别到语音。"}</p>;
  } else {
    let action;
    if (transcript?.cloudPending) {
      action = owner ? <button type="button" className="app-button-primary" onClick={() => void start(true)}>恢复原任务</button>
        : <p>请登录原 Bowerbird 账号后恢复。</p>;
    } else if (mediaKind === "audio" && overLimit) {
      action = <p role="status">音频时长超过转录上限，请先裁剪后重试。</p>;
    } else if (!owner && auth?.cloud_available) {
      action = <p>请先登录 Bowerbird 账号。</p>;
    } else if (price.loading || priceNeedsRefresh) {
      action = <p role="status">正在读取转录价格…</p>;
    } else if (price.credits === null) {
      const message = price.connectionError ? "暂时无法连接转录服务。"
        : price.reason === "pilot_exhausted" ? "本次试转录名额已使用。" : `${mediaLabel}转录服务暂不可用。`;
      action = <>
        <p role="status">{message}</p>
        {(price.connectionError || price.unavailable) &&
          <button type="button" onClick={() => { focusPanel(); refreshPrice(); }}>刷新服务状态</button>}
      </>;
    } else if (overLimit) {
      action = <p role="status">{mediaLabel}时长超过转录上限，请先裁剪后重试。</p>;
    } else {
      action = <>
        {mediaKind === "audio" && <p>将完整音轨发送至 Bowerbird Cloud，文稿保存在素材库。</p>}
        {insufficient && <p role="status">可用积分不足，请补充积分后继续。</p>}
        <button type="button" className="app-button-primary" disabled={!active || insufficient} onClick={() => void start(false)}>
          转录 · <BcoinAmount amount={price.credits}/>
        </button>
      </>;
    }
    content = <>
      {!onRead && transcript === null && <p className="video-analysis-empty-title">暂无转录文稿</p>}
      {startError && <p role="alert">{startError}</p>}
      {transcript?.status === "interrupted" && <p role="status">{transcript.priceChanged ? "转录价格已变化，请确认新价格。"
        : userErrorMessage(transcript.error, transcript.cloudPending ? "转录尚未完成，可恢复原任务。" : "转录尚未完成。")}</p>}
      {action}
    </>;
  }
  return <div ref={panel} className="video-transcript-panel" tabIndex={-1}>
    {content}
  </div>;
}
