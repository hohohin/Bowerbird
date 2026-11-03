import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { userErrorMessage } from "./userError";
import type { Asset } from "./types";
import { notifyError } from "./notify";

const STORAGE_KEY = "bowerbird.explorer.captures.v1";
export type CapturePhase = "queued" | "resolving" | "downloading" | "merging" | "saving" | "delivering" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface ExplorerCaptureRecord {
  id: string; createdAt: number; mediaKind: "image" | "video"; sourceHost: string; name?: string;
  phase: CapturePhase; receivedBytes: number; totalBytes?: number; completedSegments?: number; totalSegments?: number;
  assetId?: string; thumbnail?: string; localThumbnail?: string; error?: string; retryable?: boolean;
}
export const isCaptureActive = (item: ExplorerCaptureRecord) => !["succeeded", "failed", "cancelled", "interrupted"].includes(item.phase);
function storedString(value: unknown) { return typeof value === "string" ? value : undefined; }
function restoreRecord(value: Partial<ExplorerCaptureRecord> | null): ExplorerCaptureRecord[] {
  if (!value || typeof value.id !== "string" || typeof value.sourceHost !== "string" || !["image", "video"].includes(String(value.mediaKind))) return [];
  return [{ id: value.id, createdAt: Number(value.createdAt) || 0, mediaKind: value.mediaKind as "image" | "video",
    sourceHost: value.sourceHost, phase: ["succeeded", "failed", "cancelled", "interrupted"].includes(String(value.phase)) ? value.phase! : "interrupted", receivedBytes: 0,
    name: storedString(value.name), assetId: storedString(value.assetId), localThumbnail: storedString(value.localThumbnail) }];
}
function loadHistory(): ExplorerCaptureRecord[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(values)) return [];
    return values.slice(0, 50).flatMap(restoreRecord);
  } catch { return []; }
}
export const useExplorerCaptures = create<{ records: ExplorerCaptureRecord[] }>(() => ({ records: loadHistory() }));
let lastSerialized = "";
useExplorerCaptures.subscribe(({ records }) => {
  try {
    // Explicit allow-list: never serialize the request, browser URLs, tokens or session callbacks.
    const serialized = JSON.stringify(records.slice(0, 50).map(item => ({ id: item.id, createdAt: item.createdAt,
      mediaKind: item.mediaKind, sourceHost: item.sourceHost, name: item.name, phase: item.phase, assetId: item.assetId, localThumbnail: item.localThumbnail })));
    if (serialized !== lastSerialized) { localStorage.setItem(STORAGE_KEY, serialized); lastSerialized = serialized; }
  } catch { /* History remains available for this session when local storage is unavailable. */ }
});
export interface CaptureAttempt {
  captureId: string;
  beforeCapture: () => void;
  saved: (asset: Asset) => void;
}
interface SessionCapture {
  run: (attempt: CaptureAttempt) => Promise<void>; discard: () => void; captureId: string;
  cancelRequested: boolean; running: boolean; nativeStarted: boolean; cancelInFlight: boolean;
  nativePhase?: "resolving" | "downloading" | "merging" | "saving";
}
const sessions = new Map<string, SessionCapture>();
let queue = Promise.resolve();
let progressReady: Promise<unknown> | undefined;
function patch(id: string, value: Partial<ExplorerCaptureRecord>) {
  useExplorerCaptures.setState(state => ({ records: state.records.map(item => item.id === id ? { ...item, ...value } : item) }));
}
function record(id: string) { return useExplorerCaptures.getState().records.find(item => item.id === id); }
interface CaptureProgress {
  captureId: string; phase: "resolving" | "downloading" | "merging" | "saving";
  receivedBytes: number; totalBytes?: number; completedSegments?: number; totalSegments?: number;
}
function progressSession(payload: CaptureProgress) {
  const entry = [...sessions].find(([, session]) => session.captureId === payload.captureId && session.running);
  if (!entry || !["resolving", "downloading", "merging", "saving"].includes(payload.phase)) return;
  const current = record(entry[0]);
  if (!current || !isCaptureActive(current) || current.assetId) return;
  return entry;
}
function progressNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function receiveProgress(payload: CaptureProgress) {
  const entry = progressSession(payload);
  if (!entry) return;
  const [id, session] = entry;
  session.nativePhase = payload.phase;
  if (payload.phase === "saving") session.cancelRequested = false;
  patch(id, { phase: session.cancelRequested ? "cancelling" : payload.phase, receivedBytes: progressNumber(payload.receivedBytes) ?? 0,
    totalBytes: progressNumber(payload.totalBytes), completedSegments: progressNumber(payload.completedSegments), totalSegments: progressNumber(payload.totalSegments) });
  if (session.cancelRequested) void requestNativeCancel(id, session);
}
function listenForProgress() {
  return progressReady ??= listen<CaptureProgress>("source-browser://capture-progress", ({ payload }) => receiveProgress(payload));
}
function savedAsset(id: string, asset: Asset) {
  const localThumbnail = asset.thumb_path && !/^(https?:|blob:|data:)/i.test(asset.thumb_path) ? asset.thumb_path : undefined;
  patch(id, { assetId: asset.id, name: /^(https?:|blob:|data:)/i.test(asset.name) ? undefined : asset.name,
    thumbnail: asset.thumb_path || undefined, localThumbnail, phase: "delivering" });
}
function captureAttempt(id: string, session: SessionCapture): CaptureAttempt {
  return { captureId: session.captureId, beforeCapture: () => {
    if (session.cancelRequested) throw new Error("采集已取消");
    session.nativeStarted = true;
  }, saved: asset => savedAsset(id, asset) };
}
function discardSession(id: string, session: SessionCapture) {
  patch(id, { phase: "cancelled", retryable: false });
  session.discard(); sessions.delete(id);
}
function failedSession(id: string, session: SessionCapture, error: unknown) {
  console.error("Explorer capture failed", error);
  const saved = !!record(id)?.assetId;
  if (!saved && session.cancelRequested) {
    patch(id, { phase: "cancelled", retryable: false, error: undefined });
    sessions.delete(id); return;
  }
  patch(id, { phase: "failed", retryable: true, error: userErrorMessage(error, saved ? "素材已入库，交付未完成，请重试" : "采集失败，请重试") });
  notifyError(null, saved ? "素材已入库，交付未完成，可在采集记录中重试" : "采集失败，请查看采集记录");
}
async function runSession(id: string, session: SessionCapture) {
  if (session.cancelRequested) return;
  session.running = true;
  patch(id, { phase: record(id)?.assetId ? "delivering" : "resolving" });
  try {
    await listenForProgress();
    if (session.cancelRequested) { discardSession(id, session); return; }
    await session.run(captureAttempt(id, session));
    patch(id, { phase: "succeeded", error: undefined, retryable: false });
    sessions.delete(id);
  } catch (error) { failedSession(id, session, error); }
  finally { session.running = false; }
}
function schedule(id: string, session: SessionCapture) {
  session.captureId = crypto.randomUUID(); session.cancelRequested = false; session.nativeStarted = false; session.nativePhase = undefined; session.cancelInFlight = false;
  patch(id, { phase: "queued", error: undefined, retryable: false, receivedBytes: 0, totalBytes: undefined, completedSegments: undefined, totalSegments: undefined });
  queue = queue.then(() => runSession(id, session)).catch(error => console.error("Explorer capture queue failed", error));
}
export function enqueueExplorerCapture(input: { mediaKind?: "image" | "video"; pageUrl: string; thumbnail?: string }, run: SessionCapture["run"], discard = () => {}) {
  const previous = useExplorerCaptures.getState().records;
  if (previous.filter(isCaptureActive).length >= 50) throw new Error("采集队列已满，请等待部分任务完成后再拖入");
  const id = crypto.randomUUID();
  const item: ExplorerCaptureRecord = { id, createdAt: Date.now(), mediaKind: input.mediaKind ?? "image", sourceHost: new URL(input.pageUrl).hostname,
    thumbnail: input.thumbnail, phase: "queued", receivedBytes: 0 };
  const active = previous.filter(isCaptureActive);
  const retained = new Set([...active, ...previous.filter(value => !isCaptureActive(value)).slice(0, 49 - active.length)].map(value => value.id));
  for (const key of sessions.keys()) if (!retained.has(key)) sessions.delete(key);
  useExplorerCaptures.setState({ records: [item, ...previous.filter(value => retained.has(value.id))] });
  const session: SessionCapture = { run, discard, captureId: "", cancelRequested: false, running: false, nativeStarted: false, cancelInFlight: false };
  sessions.set(id, session); schedule(id, session);
  return id;
}
export function retryExplorerCapture(id: string) {
  const session = sessions.get(id);
  if (session && record(id)?.phase === "failed") schedule(id, session);
}
function restoreAfterCancel(id: string, session: SessionCapture, captureId: string, error?: unknown) {
  if (session.captureId !== captureId) return;
  session.cancelRequested = false;
  if (record(id)?.phase === "cancelling") patch(id, { phase: session.nativePhase,
    error: error === undefined ? undefined : userErrorMessage(error, "暂未确认取消，请稍后重试") });
}
async function requestNativeCancel(id: string, session: SessionCapture) {
  if (!session.nativePhase || session.cancelInFlight) return;
  const captureId = session.captureId;
  session.cancelInFlight = true;
  try {
    const accepted = await api.cancelSourceBrowserCapture(captureId);
    if (!accepted) restoreAfterCancel(id, session, captureId);
  } catch (error) {
    restoreAfterCancel(id, session, captureId, error);
  } finally { if (session.captureId === captureId) session.cancelInFlight = false; }
}
export async function cancelExplorerCapture(id: string) {
  const session = sessions.get(id), current = record(id);
  if (!session || !current || !isCaptureActive(current) || ["saving", "delivering", "cancelling"].includes(current.phase)) return;
  session.cancelRequested = true;
  if (!session.running) { discardSession(id, session); return; }
  patch(id, { phase: "cancelling" });
  if (!session.nativeStarted) return;
  await requestNativeCancel(id, session);
}
