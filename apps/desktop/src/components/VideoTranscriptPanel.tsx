import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { useStore } from "../store";
import { userErrorMessage } from "../lib/userError";
import { videoTime } from "../lib/videoFrame";
import { getVideoTranscript, quoteVideoTranscript, startVideoTranscript, useVideoTranscriptPrice, type VideoTranscript, type VideoTranscriptQuote } from "../lib/videoTranscript";

function TranscriptStart({ assetId, owner, label, prepareOnMount, focusPanel, refreshTranscript, onStart }: {
  assetId: string;
  owner: string;
  label: string;
  prepareOnMount: boolean;
  focusPanel: () => void;
  refreshTranscript: () => void;
  onStart: (quote?: VideoTranscriptQuote, credits?: number) => void;
}) {
  const [request, setRequest] = useState(prepareOnMount ? 1 : 0);
  const [quote, setQuote] = useState<VideoTranscriptQuote>();
  const [error, setError] = useState("");
  const price = useVideoTranscriptPrice(quote?.chargeRequired && !quote.cloudPending && !quote.noAudio ? owner : null);

  useEffect(() => {
    if (!request) return;
    let current = true;
    void quoteVideoTranscript(assetId).then(value => {
      if (current) setQuote(value);
    }).catch(reason => {
      if (current) setError(userErrorMessage(reason, "无法核对视频音轨，请检查原件后重试。"));
    });
    return () => { current = false; };
  }, [assetId, request]);

  function prepare() {
    focusPanel();
    setQuote(undefined);
    setError("");
    price.refresh();
    setRequest(value => value + 1);
  }

  if (!request) return <button type="button" className="app-button-primary" onClick={prepare}>核对转录费用</button>;
  if (error) return <>
    <p role="alert">{error}</p>
    <button type="button" onClick={prepare}>重新核对转录费用</button>
  </>;
  if (!quote) return <p role="status">正在核对音轨和费用…</p>;
  if (quote.noAudio) return <p role="status">此视频没有音轨。</p>;
  if (quote.cloudPending) return <button type="button" className="app-button-primary" onClick={() => onStart()}>恢复原任务</button>;
  if (!quote.chargeRequired) return <button type="button" onClick={() => { refreshTranscript(); prepare(); }}>刷新转录状态</button>;
  if (price.loading) return <p role="status">正在读取转录价格…</p>;
  if (price.credits === null) return <>
    <p role="status">视频转录服务暂不可用。</p>
    <button type="button" onClick={price.refresh}>刷新服务状态</button>
  </>;
  const credits = price.credits;
  return <>
    <p>整条音轨 · {videoTime(quote.durationSeconds).split(".")[0]} · {credits} Bcoin</p>
    <p>将完整音轨发送至 Bowerbird Cloud，文稿保存在素材库。</p>
    <button type="button" className="app-button-primary" onClick={() => onStart(quote, credits)}>{label}</button>
  </>;
}

function TranscriptText({ transcript, onSeek }: {
  transcript: VideoTranscript;
  onSeek: (time: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const lines = search ? transcript.utterances.filter(line => line.text.toLocaleLowerCase().includes(search)) : transcript.utterances;
  const showText = transcript.utterances.length === 0 && (!search || transcript.text.toLocaleLowerCase().includes(search));

  async function copyTranscript() {
    try {
      await navigator.clipboard.writeText(transcript.text);
      setCopyStatus("已复制");
    } catch {
      setCopyStatus("复制失败，请选中文稿后手动复制。");
    }
  }

  return <>
    <div className="video-transcript-toolbar">
      <input type="search" aria-label="搜索文稿" placeholder="搜索文稿" value={query} onChange={event => setQuery(event.target.value)}/>
      <button type="button" onClick={() => void copyTranscript()} aria-label="复制全文" title="复制全文"><Copy size={15} aria-hidden="true"/></button>
    </div>
    {copyStatus && <p role="status" className="video-transcript-feedback">{copyStatus}</p>}
    {lines.length > 0 ? <ol className="video-transcript-lines">
      {lines.map((line, index) => <li key={`${line.startMs}:${line.endMs}:${index}`}>
        <button type="button" onClick={() => onSeek(line.startMs / 1000)} aria-label={`跳转至 ${videoTime(line.startMs / 1000)}`}>
          {videoTime(line.startMs / 1000)}
        </button>
        <span>{line.text}</span>
      </li>)}
    </ol> : showText ? <p className="video-transcript-text">{transcript.text}</p> : <p role="status">文稿中没有匹配的内容。</p>}
  </>;
}

export function VideoTranscriptPanel({ assetId, hidden, active, onSeek }: {
  assetId: string;
  hidden: boolean;
  active: boolean;
  onSeek: (time: number) => void;
}) {
  const [transcript, setTranscript] = useState<VideoTranscript | null>();
  const [loadError, setLoadError] = useState("");
  const [startError, setStartError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [revision, setRevision] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const userId = useStore(state => state.cloudAuth?.logged_in ? state.cloudAuth.user_id : null);
  const focusPanel = () => panel.current?.focus({ preventScroll: true });
  const refresh = () => { setLoadError(""); setRevision(value => value + 1); };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const current = await getVideoTranscript(assetId);
        if (disposed) return;
        setTranscript(current);
        setLoadError("");
        if (current?.status === "running") timer = setTimeout(read, 1800);
      } catch (reason) {
        if (!disposed) setLoadError(userErrorMessage(reason, "转录状态暂时无法读取，请刷新。"));
      }
    }
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [assetId, revision]);

  async function start(quote?: VideoTranscriptQuote, expectedCredits?: number) {
    const auth = useStore.getState().cloudAuth;
    if (pending.current || !userId || !auth?.logged_in || auth.user_id !== userId) return;
    pending.current = true;
    focusPanel();
    setSubmitting(true);
    setStartError("");
    try {
      const current = await startVideoTranscript(assetId, userId, expectedCredits, quote);
      if (!mounted.current) return;
      setTranscript(current);
      if (current.status === "running") refresh();
    } catch (reason) {
      if (mounted.current) {
        setStartError(userErrorMessage(reason, "转录请求暂时无法确认，请检查任务状态后重试。"));
        refresh();
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  return <div ref={panel} className="video-transcript-panel" tabIndex={-1} hidden={hidden}>
    {loadError ? <>
      <p role="alert">{loadError}</p>
      <button type="button" onClick={() => { focusPanel(); refresh(); }}>刷新转录状态</button>
    </> : submitting || transcript?.status === "running"
      ? <p role="status">{submitting ? "正在准备转录…" : "正在转录，关闭预览后可回来查看。"}</p>
      : transcript === undefined ? <p role="status">正在读取转录文稿…</p>
      : transcript?.status === "completed" ? <TranscriptText transcript={transcript} onSeek={onSeek}/>
      : transcript?.status === "no_audio" ? <p role="status">此视频没有音轨。</p>
      : transcript?.status === "no_speech" ? <p role="status">未识别到语音。</p>
      : <>
        {startError && <p role="alert">{startError}</p>}
        {transcript?.status === "interrupted" && <>
          <p role="status">{userErrorMessage(transcript.error, transcript.cloudPending
            ? "转录尚未完成，可恢复原任务。" : "转录尚未完成，可核对费用后重试。")}</p>
        </>}
        {transcript?.cloudPending ? (userId
          ? <button type="button" className="app-button-primary" onClick={() => void start()}>恢复原任务</button>
          : <p>请登录原 Bowerbird 账号后恢复。</p>)
          : !userId ? <p>登录 Bowerbird 后即可获取转录。</p>
          : active && <TranscriptStart key={userId} assetId={assetId} owner={userId}
            prepareOnMount={Boolean(transcript?.quoteRequired || transcript?.priceChanged)}
            focusPanel={focusPanel} refreshTranscript={refresh} label={transcript?.status === "interrupted" ? "重试转录" : "获取转录"}
            onStart={(quote, credits) => void start(quote, credits)}/>}
      </>}
  </div>;
}
