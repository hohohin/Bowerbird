import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy } from "lucide-react";
import { videoTime } from "../lib/videoFrame";
import type { VideoTranscript } from "../lib/videoTranscript";
import { OverlayScrollArea } from "./CollectionScrollArea";
import "./VideoTranscriptReader.css";

type Utterance = VideoTranscript["utterances"][number];
type DisplayRow = Utterance | { text: string };
type TextRange = { start: number; end: number };

const GAP = /[\s\p{P}]/u;
const LATIN_OR_NUMBER = /[\p{Script=Latin}\p{N}]/u;

function alignFromEdge(text: string, tokens: string[], fromEnd: boolean) {
  const ranges = new Map<number, TextRange>();
  let cursor = fromEnd ? text.length : 0;
  for (let step = 0; step < tokens.length; step++) {
    const index = fromEnd ? tokens.length - 1 - step : step;
    const token = tokens[index];
    if (fromEnd) {
      while (cursor > 0 && GAP.test(text[cursor - 1])) cursor--;
    } else {
      while (cursor < text.length && GAP.test(text[cursor])) cursor++;
    }
    const start = fromEnd ? cursor - token.length : cursor;
    const end = start + token.length;
    if (start < 0 || end > text.length || text.slice(start, end).toLowerCase() !== token.toLowerCase()) break;
    if ((LATIN_OR_NUMBER.test(token[0]) && LATIN_OR_NUMBER.test(text.charAt(start - 1)))
      || (LATIN_OR_NUMBER.test(token[token.length - 1]) && LATIN_OR_NUMBER.test(text.charAt(end)))) break;
    ranges.set(index, { start, end });
    cursor = fromEnd ? start : end;
  }
  return ranges;
}

function timedText(utterance: Utterance) {
  const tokens = utterance.words?.map(word => ({
    ...word, matchText: word.text.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, ""),
  })).filter(word => /[\p{L}\p{N}]/u.test(word.matchText));
  if (!tokens?.length) return [];
  // Anchor on both edges. Repeated text with conflicting positions and rewritten ITN text have no seek target.
  const words = tokens.map(word => word.matchText);
  const forward = alignFromEdge(utterance.text, words, false);
  const backward = alignFromEdge(utterance.text, words, true);
  const ranges: (TextRange & { time: number })[] = [];
  let lastPosition = 0;
  let lastTime = utterance.startMs;
  for (const [index, token] of tokens.entries()) {
    const first = forward.get(index);
    const last = backward.get(index);
    if (first && last && first.start !== last.start) continue;
    const range = first ?? last;
    if (!range) continue;
    if (range.start < lastPosition) return [];
    lastPosition = range.end;
    if (!Number.isFinite(token.startMs) || !Number.isFinite(token.endMs) || token.startMs < lastTime
      || token.endMs < token.startMs || token.endMs > utterance.endMs) continue;
    ranges.push({ ...range, time: token.startMs / 1000 });
    lastTime = token.endMs;
  }
  return ranges;
}

function UtteranceText({ utterance, onSeek }: { utterance: Utterance; onSeek: (time: number) => void }) {
  const ranges = useMemo(() => timedText(utterance), [utterance]);
  let position = 0;
  const parts = ranges.map(({ start, end, time }) => {
    const before = utterance.text.slice(position, start);
    const text = utterance.text.slice(start, end);
    position = end;
    return <span key={start}>{before}<button type="button" className="video-transcript-reader-word"
      aria-label={`跳转至 ${videoTime(time)} · ${text}`} title={videoTime(time)} onClick={() => onSeek(time)}>{text}</button></span>;
  });
  return <div className="video-transcript-reader-body">{parts}{utterance.text.slice(position)}</div>;
}

function searchRows(transcript: VideoTranscript, query: string): DisplayRow[] {
  if (!query) return transcript.utterances.length ? transcript.utterances : [{ text: transcript.text }];
  const lower = query.toLowerCase();
  const lines = transcript.utterances.filter(line => line.text.toLowerCase().includes(lower));
  if (lines.length) return lines;
  // A match spanning sentence boundaries or differing from the timed tokens still belongs to the full text.
  const literal = new RegExp(query.split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "iu");
  const match = literal.exec(transcript.text);
  if (!match) return [];
  const start = Math.max(0, match.index - 80);
  const end = Math.min(transcript.text.length, match.index + match[0].length + 80);
  return [{ text: `${start ? "…" : ""}${transcript.text.slice(start, end)}${end < transcript.text.length ? "…" : ""}` }];
}

export function VideoTranscriptReader({ transcript, onSeek }: { transcript: VideoTranscript; onSeek: (time: number) => void }) {
  const [query, setQuery] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number>();
  const search = query.trim();
  const rows = useMemo(() => searchRows(transcript, search), [transcript, search]);
  const hasWordTiming = useMemo(() => transcript.utterances.some(line => Boolean(line.words?.length)), [transcript.utterances]);
  const list = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => 58,
    overscan: 5,
  });
  const items = list.getVirtualItems();

  useLayoutEffect(() => {
    pendingFocus.current = undefined;
    if (viewport.current) viewport.current.scrollTop = 0;
    list.measure();
  }, [rows, list]);

  function focusRow(index: number) {
    const row = viewport.current?.querySelector<HTMLLIElement>(`[data-index="${index}"]`);
    if (!row) return;
    pendingFocus.current = undefined;
    (row.querySelector("button") ?? row).focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    if (pendingFocus.current !== undefined) focusRow(pendingFocus.current);
  }, [items]);

  function navigate(event: KeyboardEvent<HTMLOListElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Home" && event.key !== "End") return;
    const index = Number((event.target as HTMLElement).closest<HTMLLIElement>("li[data-index]")?.dataset.index ?? -1);
    const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
      : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
    event.preventDefault();
    event.stopPropagation();
    pendingFocus.current = next;
    list.scrollToIndex(next, { align: "auto" });
    focusRow(next);
  }

  async function copyTranscript() {
    try {
      await navigator.clipboard.writeText(transcript.text);
      setCopyStatus("已复制");
    } catch {
      setCopyStatus("复制失败，请检查剪贴板权限后重试。");
    }
  }

  return <div className="video-transcript-reader">
    <div className="video-transcript-reader-tools">
      <input type="search" aria-label="搜索文稿" placeholder="搜索文稿" value={query} onChange={event => setQuery(event.target.value)}/>
      <button type="button" onClick={() => void copyTranscript()} aria-label="复制全文" title="复制全文"><Copy size={15} aria-hidden="true"/></button>
    </div>
    <p className="video-transcript-reader-timing">
      {hasWordTiming ? "点击可定位的字词跳转" : transcript.utterances.length
        ? "这份文稿只有句级时间，点击句首时间跳转。"
        : "这份文稿没有时间戳。"}
    </p>
    {copyStatus && <p role="status" className="video-transcript-reader-feedback">{copyStatus}</p>}
    <OverlayScrollArea className="video-transcript-reader-scroll" viewportClassName="video-transcript-reader-viewport" scrollRef={viewport} label="文稿滚动条">
      {rows.length > 0 ? <ol className="video-transcript-reader-lines" aria-label="转录文稿列表"
        tabIndex={0} onKeyDown={navigate} style={{ height: list.getTotalSize() }}>
        {items.map((item: ReturnType<typeof list.getVirtualItems>[number]) => {
          const row = rows[item.index];
          const timed = "startMs" in row;
          return <li key={item.key} data-index={item.index} aria-posinset={item.index + 1} aria-setsize={rows.length}
            ref={list.measureElement} tabIndex={timed ? undefined : -1} style={{ transform: `translateY(${item.start}px)` }}>
            {timed ? <>
              <button type="button" className="video-transcript-reader-time" onClick={() => onSeek(row.startMs / 1000)}
                aria-label={`跳转至 ${videoTime(row.startMs / 1000)}`}>{videoTime(row.startMs / 1000)}</button>
              <UtteranceText utterance={row} onSeek={onSeek}/>
            </> : <div className="video-transcript-reader-body is-untimed">{row.text}</div>}
          </li>;
        })}
      </ol> : <p role="status">文稿中没有匹配的内容。</p>}
    </OverlayScrollArea>
  </div>;
}
