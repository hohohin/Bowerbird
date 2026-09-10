import { api } from "./api";
import { notifySuccess } from "./notify";
import type { AppSettings } from "./types";

const notified = new Set<string>();
let audioContext: AudioContext | undefined;
let lastSoundAt = -Infinity;

function getAudioContext() {
  if (!audioContext || audioContext.state === "closed") audioContext = new AudioContext();
  return audioContext;
}

// Unlock audio during a user gesture so a long-running background task can chime later.
export function prepareGenerationSound() {
  const unlock = () => {
    try {
      const context = getAudioContext();
      if (context.state === "suspended") void context.resume().catch(() => {});
    } catch { /* Audio may be unavailable; visual reminders still work. */ }
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  return () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
}

async function playCompletionSound() {
  const context = getAudioContext();
  // Do not queue a stale chime until the next click if autoplay is blocked.
  if (context.state !== "running") return;
  if (context.currentTime - lastSoundAt < 0.6) return;
  lastSoundAt = context.currentTime;
  for (const [offset, frequency] of [[0, 660], [0.16, 880]]) {
    const start = context.currentTime + offset;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.12, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.25);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start);
    oscillator.stop(start + 0.26);
  }
}

/** Called only when fresh results have landed, never when merely opening history. */
export async function notifyGenerationComplete(key: string, message: string, settings: AppSettings | null) {
  if (notified.has(key)) return;
  notified.add(key);
  try {
    // Recovery can finish before the initial settings load. Respect saved opt-outs then too.
    const preferences = settings ?? await api.getSettings();
    if (preferences.generation_completion_popup ?? true) notifySuccess(message);
    if (preferences.generation_completion_sound ?? true) {
      await playCompletionSound().catch((error) => console.warn("Generation sound unavailable", error));
    }
  } catch (error) {
    console.warn("Generation notification unavailable", error);
  }
}
