import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export interface VideoTranscript {
  status: "running" | "completed" | "no_audio" | "no_speech" | "interrupted";
  text: string;
  utterances: { startMs: number; endMs: number; text: string }[];
  error?: string;
  cloudPending?: boolean;
  quoteRequired?: boolean;
  priceChanged?: boolean;
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
}

export function useVideoTranscriptPrice(owner: string | null) {
  const [revision, setRevision] = useState(0);
  const [price, setPrice] = useState<{ owner: string; revision: number; credits: number | null }>();

  useEffect(() => {
    if (!owner) return;
    let current = true;
    void invoke<VideoTranscriptCapabilities>("video_transcript_capabilities").then(value => {
      const credits = value?.available && typeof value.credits === "number"
        && Number.isSafeInteger(value.credits) && value.credits > 0 ? value.credits : null;
      if (current) setPrice({ owner, revision, credits });
    }).catch(() => {
      if (current) setPrice({ owner, revision, credits: null });
    });
    return () => { current = false; };
  }, [owner, revision]);

  const result = price?.owner === owner && price.revision === revision ? price : undefined;
  return { credits: result?.credits ?? null, loading: Boolean(owner && !result), refresh: () => setRevision(value => value + 1) };
}

export function getVideoTranscript(assetId: string) {
  return invoke<VideoTranscript | null>("video_transcript_get", { assetId });
}

export function useVideoTranscript(assetId: string | null, sourceKey: string) {
  const [state, setState] = useState<{ key: string; transcript?: VideoTranscript | null; error: unknown }>();
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
        setState({ key: sourceKey, transcript, error: null });
        if (transcript?.status === "running") timer = setTimeout(() => void read(id), 1800);
      } catch (error) {
        if (!disposed) setState(previous => ({
          key: sourceKey, transcript: previous?.key === sourceKey ? previous.transcript : undefined, error,
        }));
      }
    }
    void read(assetId);
    return () => { disposed = true; clearTimeout(timer); };
  }, [assetId, sourceKey, revision]);

  return {
    transcript: current?.transcript,
    error: current?.error,
    update: (transcript: VideoTranscript) => setState({ key: sourceKey, transcript, error: null }),
    refresh: () => setRevision(value => value + 1),
  };
}

export function quoteVideoTranscript(assetId: string) {
  return invoke<VideoTranscriptQuote>("video_transcript_quote", { assetId });
}

export function startVideoTranscript(assetId: string, expectedUserId?: string, expectedCredits?: number, quote?: VideoTranscriptQuote) {
  return invoke<VideoTranscript>("video_transcript_start", {
    assetId, expectedUserId, expectedCredits,
    quote: quote && { sourceHash: quote.sourceHash },
  });
}
