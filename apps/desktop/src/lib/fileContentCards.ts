import type { Asset } from './types';
import { isSpreadsheetPath, isTextAsset } from './textMedia';
import { textDocuments, textDocumentMarkdown } from './textDocuments';
import { canvasDocumentHeight, type CanvasNotePayload } from './canvasNotes';
import { readSpreadsheet, spreadsheetContentCard } from './spreadsheetDocuments';

export async function readFileContentCards(asset: Asset, sheetName?: string) {
  if (isSpreadsheetPath(asset.store_path)) {
    const document = await readSpreadsheet(asset.id);
    const sheets = sheetName === undefined ? document.sheets : document.sheets.filter(sheet => sheet.name === sheetName);
    if (!sheets.length) throw new Error('工作表已不存在，请重新打开文件');
    return sheets.map(sheet => spreadsheetContentCard(asset.name, sheet));
  }
  if (!isTextAsset(asset)) return null;
  const text = await textDocumentMarkdown(await textDocuments.read(asset.id));
  const payload: CanvasNotePayload = { schema_version: 1, note_type: 'document', title: asset.name, text, cells: [], member_ids: [] };
  return [{ payload, size: { width: 420, height: canvasDocumentHeight(420) } }];
}
