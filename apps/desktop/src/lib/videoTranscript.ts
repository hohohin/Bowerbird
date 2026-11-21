import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

type TranscriptWord = { startMs: number; endMs: number; text: string };

export interface VideoTranscript {
  status: "running" | "completed" | "no_audio" | "no_speech" | "interrupted";
  text: string;
  utterances: (TranscriptWord & { words?: TranscriptWord[] })[];
  error?: string;
  cloudPending?: boolean;
  quoteRequired?: boolean;
  priceChanged?: boolean;
  canRefreshTiming?: boolean;
}

export interface VideoTranscriptQuote {
  sourceHash: string;
  durationSeconds: number;
  chargeRequired: boolean;
  cloudPending: boolean;
  noAudio: boolean;
}

interface VideoTranscriptCapabilities {
  available: boolean;
  credits: number | null;
  maxDurationMs: number;
  reason?: "pilot_exhausted";
}

const capabilityRequests = new Map<string, Promise<VideoTranscriptCapabilities>>();

function requestCapabilities(owner: string) {
  const pending = capabilityRequests.get(owner);
  if (pending) return pending;
  const request = invoke<VideoTranscriptCapabilities>("video_transcript_capabilities").finally(() => {
    capabilityRequests.delete(owner);
  });
  capabilityRequests.set(owner, request);
  return request;
}

export function useVideoTranscriptPrice(owner: string | null) {
  const [revision, setRevision] = useState(0);
  const [price, setPrice] = useState<{ owner: string; revision: number; credits: number | null;
    reason?: VideoTranscriptCapabilities["reason"]; connectionError: boolean; maxDurationMs?: number }>();
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    if (!owner) return;
    let current = true;
    void requestCapabilities(owner).then(value => {
      const credits = value?.available && typeof value.credits === "number"
        && Number.isSafeInteger(value.credits) && value.credits > 0 ? value.credits : null;
      if (current) setPrice({ owner, revision, credits, connectionError: false,
        reason: value?.reason === "pilot_exhausted" ? value.reason : undefined,
        maxDurationMs: Number.isFinite(value?.maxDurationMs) && value.maxDurationMs > 0 ? value.maxDurationMs : undefined });
    }).catch(() => {
      if (current) setPrice({ owner, revision, credits: null, connectionError: true });
    });
    return () => { current = false; };
  }, [owner, revision]);

  const result = price?.owner === owner && price.revision === revision ? price : undefined;
  return { credits: result?.credits ?? null, reason: result?.reason, maxDurationMs: result?.maxDurationMs,
    unavailable: result?.credits === null && !result.connectionError,
    connectionError: Boolean(result?.connectionError), loading: Boolean(owner && !result), revision, refresh };
}

export function getVideoTranscript(assetId: string) {
  return invoke<VideoTranscript | null>("video_transcript_get", { assetId });
}

export function useVideoTranscript(assetId: string | null, sourceKey: string, owner?: string | null) {
  const [state, setState] = useState<{ key: string; owner?: string | null; transcript?: VideoTranscript | null; error: unknown }>();
  const [revision, setRevision] = useState(0);
  const current = state?.key === sourceKey ? state : undefined;

  useEffect(() => {
    if (!assetId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read(id: string) {
      try {
        const transcript = await getVideoTranscript(id);
        if (disposed) return;
        setState({ key: sourceKey, owner, transcript, error: null });
        if (transcript?.status === "running") timer = setTimeout(() => void read(id), 1800);
      } catch (error) {
        if (!disposed) setState(previous => ({
          key: sourceKey, owner: previous?.owner,
          transcript: previous?.key === sourceKey ? previous.transcript : undefined, error,
        }));
      }
    }
    void read(assetId);
    return () => { disposed = true; clearTimeout(timer); };
  }, [assetId, sourceKey, owner, revision]);

  const transcript = current?.transcript;
  return {
    transcript: transcript?.canRefreshTiming && current?.owner !== owner
      ? { ...transcript, canRefreshTiming: false }
      : transcript,
    error: current?.error,
    update: (transcript: VideoTranscript) => setState({ key: sourceKey, owner, transcript, error: null }),
    refresh: () => setRevision(value => value + 1),
  };
}

export function quoteVideoTranscript(assetId: string) {
  return invoke<VideoTranscriptQuote>("video_transcript_quote", { assetId });
}

export function refreshVideoTranscriptTiming(assetId: string, expectedUserId: string) {
  return invoke<VideoTranscript>("video_transcript_refresh_timing", { assetId, expectedUserId });
}

export function startVideoTranscript(assetId: string, expectedUserId?: string, expectedCredits?: number, quote?: VideoTranscriptQuote) {
  return invoke<VideoTranscript>("video_transcript_start", {
    assetId, expectedUserId, expectedCredits,
    quote: quote && { sourceHash: quote.sourceHash },
  });
}
