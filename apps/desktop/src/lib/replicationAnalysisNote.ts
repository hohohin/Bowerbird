import { emptyCanvasCell, type CanvasNotePayload } from './canvasNotes';
export interface ReplicationAnalysisRow { index: number; start: number; end: number; text: string; dataUrl: string }
export interface ReplicationAnalysisOutput { id: string; rows: ReplicationAnalysisRow[] }
export function replicationAnalysisNote(rows: (ReplicationAnalysisRow & { assetId: string })[]): CanvasNotePayload {
  return { schema_version: 1, note_type: 'text', title: '强化分析', text: '', member_ids: [], column_widths: [0.4, 0.6],
    cells: rows.map(row => [
      { ...emptyCanvasCell(), id: `shot-${row.index}-frame`, content_type: 'image', image_refs: [{ asset_id: row.assetId, token: '@图片1' }] },
      { ...emptyCanvasCell(), id: `shot-${row.index}-analysis`, text: `镜头 ${row.index + 1} · ${row.start.toFixed(2)}–${row.end.toFixed(2)} 秒\n\n${row.text}` },
    ]) };
}
