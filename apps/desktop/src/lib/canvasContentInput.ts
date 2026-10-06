import { canvasGridWeights, emptyCanvasCell, type CanvasNotePayload } from "./canvasNotes";
import type { WorkflowNode, WorkflowValue } from "./canvasWorkflow";

/** Write one delivery into its reserved slots; the runtime allocates new slots for each main-port delivery. */
export function canvasContentInput(note: CanvasNotePayload, target: NonNullable<WorkflowNode["textTarget"]>, value: WorkflowValue, reservedCellIds: string[] = []) {
  if (target.append && value.type === "text" && (value.table || target.tableCellIds)) return tableContentInput(note, target, value, reservedCellIds);
  const separate = target.append && value.type === "image";
  const cellIds = separate ? [target.cellId, ...(target.cellIds ?? []).filter(id => id !== target.cellId)] : [target.cellId];
  const cells = note.cells.map(row => row.map(cell => ({ ...cell })));
  const weights = canvasGridWeights(note.row_heights, cells.length).slice();
  const columns = canvasGridWeights(note.column_widths, cells[0].length).slice();
  const ids = [...new Set(value.assetIds ?? [])];
  if (value.type === "image" && !ids.length) return { cellIds, tableCellIds: undefined, note };
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
  return { cellIds, tableCellIds: undefined, note: { ...note, note_type: "text" as const, cells, column_widths: columns, row_heights: weights, text: cells.map(row => row.map(cell => cell.text).join("\t")).join("\n") } };
}

/** Restore missing owned rows/columns after a partial save or table resize, by insertion only. */
function restoreTableGrid(cells: CanvasNotePayload["cells"], grid: string[][], columns: number[], weights: number[]) {
  const existing = new Map(cells.flatMap((row, r) => row.map((cell, c) => [cell.id!, { r, c }])));
  if (grid.flat().every(id => existing.has(id))) return;
  const invalid = () => new Error("表格接收区域的单元格位置已改变，请重新连接内容卡片");
  const rows: (number | undefined)[] = grid.map(() => undefined);
  const cols: (number | undefined)[] = grid[0].map(() => undefined);
  for (const [r, row] of grid.entries()) for (const [c, id] of row.entries()) {
    const position = existing.get(id);
    if (!position) continue;
    if (rows[r] !== undefined && rows[r] !== position.r || cols[c] !== undefined && cols[c] !== position.c) throw invalid();
    rows[r] = position.r; cols[c] = position.c;
  }
  // An intact anchor and ordered surviving cells identify the original region.
  for (const positions of [rows, cols]) {
    const present = positions.filter((position): position is number => position !== undefined);
    if (positions[0] === undefined || present.some((position, i) => i > 0 && position <= present[i - 1])) throw invalid();
  }
  const created = new Set<string>();
  const create = () => { const id = crypto.randomUUID(); created.add(id); return { ...emptyCanvasCell(), id }; };
  for (const [positions, sizes, isRow] of [[rows, weights, true], [cols, columns, false]] as const) {
    for (let index = 0; index < positions.length; index++) {
      if (positions[index] !== undefined) continue;
      const position = positions.slice(index + 1).find(value => value !== undefined) ?? positions[index - 1]! + 1;
      for (let i = 0; i < positions.length; i++) if (positions[i] !== undefined && positions[i]! >= position) positions[i] = positions[i]! + 1;
      positions[index] = position;
      sizes.splice(position, 0, 1);
      if (isRow) cells.splice(position, 0, columns.map(create));
      else for (const row of cells) row.splice(position, 0, create());
    }
  }
  for (const [r, row] of grid.entries()) for (const [c, id] of row.entries()) {
    if (existing.has(id)) continue;
    const cell = cells[rows[r]!][cols[c]!];
    // A replacement at an existing position may be user content, even if empty.
    if (!created.has(cell.id!)) throw invalid();
    cell.id = id;
  }
}

/** A whole-card table input owns a grid of stable cells, never its neighbors. */
function tableContentInput(note: CanvasNotePayload, target: NonNullable<WorkflowNode["textTarget"]>, value: WorkflowValue, reserved: string[]) {
  const cells = note.cells.map(row => row.map(cell => ({ ...cell })));
  const columns = canvasGridWeights(note.column_widths, cells[0].length).slice();
  const weights = canvasGridWeights(note.row_heights, cells.length).slice();
  const grid = target.tableCellIds?.map(row => [...row]) ?? [[target.cellId]];
  const owned = new Set(target.cellIds ?? [target.cellId]);
  if (grid.flat().some(id => !owned.has(id) || reserved.includes(id))) {
    throw new Error("表格接收区域已删除或改接其他输入，请重新连接内容卡片");
  }
  restoreTableGrid(cells, grid, columns, weights);
  const data = value.table ? [value.table.columns, ...value.table.rows] : [[value.text ?? ""]];
  const firstRow = cells.findIndex(row => row.some(cell => cell.id === target.cellId));
  const firstColumn = cells[firstRow].findIndex(cell => cell.id === target.cellId);
  const width = Math.max(data[0].length, ...grid.map(row => row.length));
  while (columns.length < firstColumn + width) {
    columns.push(1);
    for (const row of cells) row.push({ ...emptyCanvasCell(), id: crypto.randomUUID() });
  }
  while (grid.length < data.length) {
    const after = cells.findIndex(row => row.some(cell => cell.id === grid[grid.length - 1][0]));
    const row = columns.map(() => ({ ...emptyCanvasCell(), id: crypto.randomUUID() }));
    cells.splice(after + 1, 0, row); weights.splice(after + 1, 0, 1);
    grid.push([row[firstColumn].id]);
  }
  for (const row of grid) {
    const actual = cells.find(items => items.some(cell => cell.id === row[0]))!;
    while (row.length < width) {
      const column = actual.findIndex(cell => cell.id === row[row.length - 1]) + 1;
      const cell = actual[column];
      if (!cell || cell.text || cell.image_refs?.length || reserved.includes(cell.id!)) throw new Error("表格展开位置已有内容或输入连接，请使用空白内容卡片");
      row.push(cell.id!);
    }
  }
  for (const [r, row] of grid.entries()) for (const [c, id] of row.entries()) {
    const cell = cells.flat().find(cell => cell.id === id)!;
    Object.assign(cell, { content_type: "text", text: data[r]?.[c] ?? "", image_refs: [], bold: !!value.table && r === 0 });
  }
  return { cellIds: grid.flat(), tableCellIds: grid, note: { ...note, note_type: "text" as const, cells, column_widths: columns, row_heights: weights,
    text: cells.map(row => row.map(cell => cell.text).join("\t")).join("\n") } };
}
