import { emptyCanvasCell, readCanvasNote, type CanvasTextCell } from "./canvasNotes.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Revert only the user's changed fields, preserving newer values from generation or another window. */
export function restoreCanvasNoteEdit(currentJson: string, beforeJson: string, afterJson: string): string {
  if (currentJson === afterJson) return beforeJson;
  const current = readCanvasNote({ payloadJson: currentJson }), before = readCanvasNote({ payloadJson: beforeJson }), after = readCanvasNote({ payloadJson: afterJson });
  function restoreFields<T extends object>(current: T, before: T, after: T, skip?: string): T {
    const result = { ...current };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof T>) {
      if (key === skip || same(before[key], after[key]) || !same(current[key], after[key])) continue;
      if (key in before) result[key] = before[key]; else delete result[key];
    }
    return result;
  }
  const result = restoreFields(current, before, after, "cells");
  if (!same(before.cells, after.cells)) {
    const previous = new Map(before.cells.flat().map(cell => [cell.id, cell])), next = new Map(after.cells.flat().map(cell => [cell.id, cell]));
    const live = new Map(current.cells.flat().map(cell => [cell.id, cell]));
    const restored = (cell: CanvasTextCell) => {
      const a = previous.get(cell.id), b = next.get(cell.id);
      return a && b ? restoreFields(cell, a, b) : cell;
    };
    const structure = (cells: CanvasTextCell[][]) => cells.map(row => row.map(cell => cell.id));
    if (same(structure(before.cells), structure(after.cells))) result.cells = current.cells.map(row => row.map(restored));
    else {
      result.cells = before.cells.map(row => row.map(cell => live.has(cell.id) ? restored(live.get(cell.id)!) : cell));
      // Retain cells added or changed since the recorded edit instead of erasing new results.
      for (const row of current.cells) {
        const extra = row.filter(cell => !previous.has(cell.id) && (!next.has(cell.id) || !same(cell, next.get(cell.id))));
        if (extra.length) result.cells.push(extra);
      }
      const columns = Math.max(...result.cells.map(row => row.length));
      result.cells = result.cells.map(row => [...row, ...Array.from({ length: columns - row.length }, () => ({ ...emptyCanvasCell(), id: crypto.randomUUID() }))]);
    }
    if (result.note_type === "text" || result.note_type === "images" || result.note_type === "bubble") result.text = result.cells.map(row => row.map(cell => cell.text).join("\t")).join("\n");
  }
  return JSON.stringify(result);
}
