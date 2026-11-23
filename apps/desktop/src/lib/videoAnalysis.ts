import { invoke } from "@tauri-apps/api/core";

export type VideoAnalysisQuote = {
  durationSeconds: number;
  durationMs: number;
  sourceHash: string;
  segmentCount: number;
  credits: number | null;
  chargeRequired: boolean;
  cloudPending: boolean;
  pricingVersion: number | null;
};
export type PricedVideoAnalysisQuote = VideoAnalysisQuote & { credits: number; pricingVersion: number };

export function hasVideoAnalysisPrice(quote?: VideoAnalysisQuote): quote is PricedVideoAnalysisQuote {
  return quote?.credits != null && quote.pricingVersion != null;
}

export type VideoAnalysisProgress = {
  status: "completed" | "running" | "interrupted";
  segmentCount: number;
  completedSegments: number;
  cloudPending?: boolean;
  quoteRequired?: boolean;
  priceChanged?: boolean;
  error?: unknown;
};

export function getVideoAnalysisCapabilities() {
  return invoke<{ available: boolean }>("video_analysis_capabilities");
}

export function quoteVideoAnalysis(assetId: string) {
  return invoke<VideoAnalysisQuote>("video_analysis_quote", { assetId });
}

export function getVideoAnalysisProgress(assetId: string) {
  return invoke<VideoAnalysisProgress | null>("video_analysis_progress", { assetId });
}

export function pauseVideoAnalysis(assetId: string, expectedUserId: string) {
  return invoke<boolean>("video_analysis_pause", { assetId, expectedUserId });
}

export function startVideoAnalysis(assetId: string, expectedUserId: string, quote: PricedVideoAnalysisQuote) {
  return invoke<VideoAnalysisProgress>("video_analysis_start", {
    assetId, expectedUserId, expectedCredits: quote.credits,
    expectedSourceHash: quote.sourceHash, expectedPricingVersion: quote.pricingVersion,
  });
}

export function formatVideoAnalysisDuration(seconds: number) {
  const whole = Math.ceil(seconds);
  return [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60]
    .map(part => String(part).padStart(2, "0")).join(":");
}
