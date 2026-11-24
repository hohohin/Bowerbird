import { useEffect, useRef, useState, type SetStateAction } from "react";
import { normalizeDraftBrushSize } from "../lib/draftBrushSize";

export type DraftBrushTool = "brush" | "eraser";
export type DraftBrushPreferences = { size: number; hardness: number; opacity: number; smoothing: number; pressure: boolean; inertia: number };
type NumericPreference = Exclude<keyof DraftBrushPreferences, "pressure">;
type Preferences = Record<DraftBrushTool, DraftBrushPreferences>;
const STORAGE_KEY = "bowerbird.draftBrushPreferences";
const DEFAULTS: DraftBrushPreferences = { size: 16, hardness: 1, opacity: 1, smoothing: .15, pressure: true, inertia: 0 };
const LIMITS: Record<NumericPreference, [number, number]> = {
  size: [.5, 500], hardness: [0, 1], opacity: [.01, 1], smoothing: [0, .8], inertia: [0, 1],
};

function bounded(value: unknown, key: NumericPreference, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (key === "size") return normalizeDraftBrushSize(value, fallback);
  const [min, max] = LIMITS[key];
  return Math.min(max, Math.max(min, value));
}

function parseTool(value: unknown): DraftBrushPreferences {
  const saved = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { size: bounded(saved.size, "size", DEFAULTS.size), hardness: bounded(saved.hardness, "hardness", DEFAULTS.hardness),
    opacity: bounded(saved.opacity, "opacity", DEFAULTS.opacity), smoothing: bounded(saved.smoothing, "smoothing", DEFAULTS.smoothing),
    pressure: typeof saved.pressure === "boolean" ? saved.pressure : DEFAULTS.pressure, inertia: bounded(saved.inertia, "inertia", DEFAULTS.inertia) };
}

function readPreferences(): Preferences {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved && typeof saved === "object" && !Array.isArray(saved) && "version" in saved && saved.version === 1) {
      const values = saved as Record<string, unknown>;
      return { brush: parseTool(values.brush), eraser: parseTool(values.eraser) };
    }
  } catch { /* Keep drawing available when local preferences cannot be read. */ }
  return { brush: { ...DEFAULTS }, eraser: { ...DEFAULTS } };
}

/** Tool preferences stay outside document pixels/history and survive editor remounts. */
export function useDraftBrushPreferences(tool: DraftBrushTool) {
  const [preferences, setPreferences] = useState(readPreferences);
  const persisted = useRef(preferences);
  useEffect(() => {
    // Do not rewrite storage on mount or during StrictMode's effect replay.
    if (preferences === persisted.current) return;
    persisted.current = preferences;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...preferences })); }
    catch { /* The current editor session remains usable if storage is unavailable. */ }
  }, [preferences]);

  function update(key: NumericPreference, action: SetStateAction<number>) {
    setPreferences(previous => {
      const current = previous[tool][key];
      const value = bounded(typeof action === "function" ? action(current) : action, key, current);
      return value === current ? previous : { ...previous, [tool]: { ...previous[tool], [key]: value } };
    });
  }
  return { ...preferences[tool],
    setSize: (value: SetStateAction<number>) => update("size", value),
    setHardness: (value: SetStateAction<number>) => update("hardness", value),
    setOpacity: (value: SetStateAction<number>) => update("opacity", value),
    setSmoothing: (value: SetStateAction<number>) => update("smoothing", value),
    setInertia: (value: SetStateAction<number>) => update("inertia", value),
    setPressure: (action: SetStateAction<boolean>) => setPreferences(previous => {
      const current = previous[tool].pressure, value = typeof action === "function" ? action(current) : action;
      return typeof value !== "boolean" || value === current ? previous : { ...previous, [tool]: { ...previous[tool], pressure: value } };
    }) };
}
