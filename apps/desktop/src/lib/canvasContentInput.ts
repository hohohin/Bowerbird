import { canvasGridWeights, emptyCanvasCell, type CanvasNotePayload } from "./canvasNotes";
import type { WorkflowNode, WorkflowValue } from "./canvasWorkflow";

/** Main image inputs own stable slots; cell inputs continue to replace just one cell. */
export function canvasContentInput(note: CanvasNotePayload, target: NonNullable<WorkflowNode["textTarget"]>, value: WorkflowValue) {
  const separate = target.append && value.type === "image";
  const cellIds = separate ? [target.cellId, ...(target.cellIds ?? []).filter(id => id !== target.cellId)] : [target.cellId];
  const cells = note.cells.map(row => row.map(cell => ({ ...cell })));
  const weights = canvasGridWeights(note.row_heights, cells.length).slice();
  const columns = canvasGridWeights(note.column_widths, cells[0].length).slice();
  const ids = [...new Set(value.assetIds ?? [])];
  if (value.type === "image" && !ids.length) return { cellIds, note };
  if (separate) {
    while (cellIds.length < ids.length) cellIds.push(crypto.randomUUID());
    const width = Math.ceil(Math.sqrt(Math.max(1, ids.length)));
    while (columns.length < width) {
      columns.push(1);
      for (const row of cells) row.push({ ...emptyCanvasCell(), id: crypto.randomUUID() });
    }
    // The binding creates a fresh first row. Fill this batch left to right,
    // adding rows only when its square-ish width is exhausted. On reruns keep
    // existing slots (and downstream references), allocating only missing ones.
    const firstRow = cells.findIndex(row => row.some(cell => cell.id === target.cellId));
    let row = firstRow;
    let column = 1;
    const fresh = !target.cellIds?.length && firstRow >= 0
      && cells[firstRow][0].id === target.cellId
      && cells[firstRow].slice(1, width).every(cell => !cell.text && !cell.image_refs?.length);
    if (!fresh) { row = cells.length - 1; column = width; }
    for (const id of cellIds.slice(0, ids.length)) {
      if (cells.some(items => items.some(cell => cell.id === id))) continue;
      if (column >= width) {
        row += 1;
        cells.splice(row, 0, columns.map(() => ({ ...emptyCanvasCell(), id: crypto.randomUUID() })));
        weights.splice(row, 0, 1);
        column = 0;
      }
      cells[row][column] = { ...emptyCanvasCell(), id };
      column += 1;
    }
  }
  for (const row of cells) for (const cell of row) {
    const index = cellIds.indexOf(cell.id ?? "");
    if (index < 0) continue;
    const assetIds = separate ? ids.slice(index, index + 1) : ids;
    if (value.type === "image" && !assetIds.length) continue;
    cell.content_type = value.type === "image" ? "image" : "text";
    cell.text = value.type === "text" ? value.text ?? "" : assetIds.map((_, i) => `@图片${i + 1}`).join(" ");
    cell.image_refs = value.type === "text" ? value.imageRefs ?? [] : assetIds.map((asset_id, i) => ({ asset_id, token: `@图片${i + 1}` }));
  }
  return { cellIds, note: { ...note, note_type: "text" as const, cells, column_widths: columns, row_heights: weights, text: cells.map(row => row.map(cell => cell.text).join("\t")).join("\n") } };
}
