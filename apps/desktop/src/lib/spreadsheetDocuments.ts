import { invoke } from '@tauri-apps/api/core';
import { canvasTextMinSize, emptyCanvasCell, type CanvasNotePayload } from './canvasNotes';

export interface SpreadsheetSheet { name: string; rows: string[][] }
export interface SpreadsheetDocument { sheets: SpreadsheetSheet[] }
export const readSpreadsheet = (assetId: string) => invoke<SpreadsheetDocument>('read_spreadsheet_document', { assetId });

export function spreadsheetContentCard(name: string, sheet: SpreadsheetSheet) {
  const cells = sheet.rows.map(row => row.map(text => ({ ...emptyCanvasCell(), id: crypto.randomUUID(), text })));
  const payload: CanvasNotePayload = { schema_version: 1, note_type: 'text', title: `${name} · ${sheet.name}`,
    text: sheet.rows.map(row => row.join('\t')).join('\n'), cells, member_ids: [] };
  const minimum = canvasTextMinSize(cells);
  return { payload, size: { width: Math.max(420, minimum.width), height: Math.max(240, minimum.height) } };
}
