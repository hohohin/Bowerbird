import { canvasGridWeights, emptyCanvasCell, type CanvasNotePayload } from "./canvasNotes";
import type { WorkflowNode, WorkflowValue } from "./canvasWorkflow";
import { contentTableRows, parseTextTable } from "./contentTable";

/** Write one delivery into its reserved slots; the runtime allocates new slots for each main-port delivery. */
export function canvasContentInput(note: CanvasNotePayload, target: NonNullable<WorkflowNode["textTarget"]>, value: WorkflowValue, reservedCellIds: string[] = []) {
  if (target.appendAxis) return axisContentInput(note, target, value, reservedCellIds);
  if (value.type === "text") {
    const rows = value.table ? contentTableRows(value.table) : parseTextTable(value.text ?? "") ?? [[value.text ?? ""]];
    const table = { ...value.table, columns: undefined, rows };
    if (target.append) return tableContentInput(note, target, { ...value, table }, reservedCellIds);
    if (rows.length !== 1 || rows[0].length !== 1) throw new Error("多格表格请连接内容卡片的行或列输入；指定单元格仅接收 1×1 子表，避免覆盖相邻内容");
    value = { ...value, text: rows[0][0] };
  }
  const separate = target.append && value.type === "image";
  const cellIds = separate ? [target.cellId, ...(target.cellIds ?? []).filter(id => id !== target.cellId)] : [target.cellId];
  const cells = note.cells.map(row => row.map(cell => ({ ...cell })));
  const weights = canvasGridWeights(note.row_heights, cells.length).slice();
  const columns = canvasGridWeights(note.column_widths, cells[0].length).slice();
  const ids = [...new Set(value.assetIds ?? [])];
  const sessions = [...new Set(value.nodeIds ?? [])];
  const entries = [...ids.map(assetId => ({ assetId, sessionId: undefined as string | undefined })), ...sessions.map(sessionId => ({ assetId: undefined as string | undefined, sessionId }))];
  if (!target.append && sessions.length && entries.length > 1) throw new Error("多个生成结果请连接内容卡行或列图片输入，每个任务占一个单元格");
  if (value.type === "image" && !entries.length) return { cellIds, tableCellIds: undefined, note };
  if (separate) {
    while (cellIds.length < entries.length) cellIds.push(crypto.randomUUID());
    const width = Math.ceil(Math.sqrt(Math.max(1, entries.length)));
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
      && cells[firstRow].slice(1, width).every(cell => !cell.text && !cell.image_refs?.length && !cell.generation_ref);
    if (!fresh) { row = cells.length - 1; column = width; }
    for (const id of cellIds.slice(0, entries.length)) {
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
    const entry = entries[separate ? index : 0];
    const assetIds = separate ? entry?.assetId ? [entry.assetId] : [] : ids;
    if (value.type === "image" && !entry) continue;
    if (value.type === "image" && entry?.sessionId) {
      cell.content_type = "image"; cell.text = ""; cell.image_refs = [];
      cell.generation_ref = { session_node_id: entry.sessionId };
      continue;
    }
    delete cell.generation_ref;
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
  const data = value.table ? contentTableRows(value.table) : [[value.text ?? ""]];
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
    const text = data[r]?.[c] ?? "";
    const image = value.table?.imageCells?.some(([row, column]) => row === r && column === c);
    const refs = value.imageRefs?.filter(ref => text.split(ref.token).slice(1).some(suffix => !/^\d/.test(suffix))) ?? [];
    delete cell.generation_ref;
    Object.assign(cell, { content_type: image ? "image" : "text", text, image_refs: refs, bold: !!value.table?.columns && r === 0 });
  }
  return { cellIds: grid.flat(), tableCellIds: grid, note: { ...note, note_type: "text" as const, cells, column_widths: columns, row_heights: weights,
    text: cells.map(row => row.map(cell => cell.text).join("\t")).join("\n") } };
}

/** Axis membership uses surviving cell identities, so inserting a row/column never redirects a wire. */
export function contentInputAxisIndex(note: CanvasNotePayload, target: NonNullable<WorkflowNode["textTarget"]>) {
  const ids = new Set(target.axisCellIds ?? []);
  if (target.appendAxis === "row") return note.cells.findIndex(row => row.some(cell => ids.has(cell.id!)));
  return note.cells[0].findIndex((_, column) => note.cells.some(row => ids.has(row[column].id!)));
}

export function contentInputPort(note: CanvasNotePayload, target: NonNullable<WorkflowNode["textTarget"]>) {
  if (!target.append) return target.cellId;
  if (!target.appendAxis) return `column:${note.cells[0][0].id}`; // Legacy whole-card wires remain accessible.
  const index = contentInputAxisIndex(note, target);
  if (index < 0) return undefined;
  return `${target.appendAxis}:${target.appendAxis === "row" ? note.cells[index][0].id : note.cells[0][index].id}`;
}

/** Each delivery is a sequence of cells along one row or column, including blank table entries. */
function axisContentInput(note: CanvasNotePayload, target: NonNullable<WorkflowNode["textTarget"]>, value: WorkflowValue, reserved: string[]) {
  const index = contentInputAxisIndex(note, target);
  if (index < 0) throw new Error("接收产物的行或列已删除，请重新连接输出");
  const cells = note.cells.map(row => row.map(cell => ({ ...cell })));
  const columns = canvasGridWeights(note.column_widths, cells[0].length).slice();
  const weights = canvasGridWeights(note.row_heights, cells.length).slice();
  const alongRow = target.appendAxis === "row";
  const axisCells = () => alongRow ? cells[index] : cells.map(row => row[index]);
  const rows = value.table ? contentTableRows(value.table) : parseTextTable(value.text ?? "") ?? [[value.text ?? ""]];
  const entries: WorkflowValue[] = value.type === "image"
    ? [...[...new Set(value.assetIds ?? [])].map(assetId => ({ type: "image" as const, assetIds: [assetId] })),
      ...[...new Set(value.nodeIds ?? [])].map(sessionId => ({ type: "image" as const, nodeIds: [sessionId] }))]
    : rows.flatMap((row, r) => row.map((text, c): WorkflowValue => ({ type: value.table?.imageCells?.some(([y, x]) => y === r && x === c) ? "image" : "text", text,
      imageRefs: value.imageRefs?.filter(ref => text.split(ref.token).slice(1).some(suffix => !/^\d/.test(suffix))),
      assetIds: value.imageRefs?.filter(ref => text.split(ref.token).slice(1).some(suffix => !/^\d/.test(suffix))).map(ref => ref.asset_id) })));
  const occupied = (cell: CanvasNotePayload["cells"][number][number]) => !!(cell.text || cell.image_refs?.length || cell.generation_ref || reserved.includes(cell.id!));
  const axis = axisCells();
  const offset = target.axisOffset ?? axis.reduce((end, cell, i) => occupied(cell) ? i + 1 : end, 0);
  const cellIds = target.cellIds?.slice() ?? entries.map((_, i) => axis[offset + i]?.id ?? crypto.randomUUID());
  if (cellIds.length !== entries.length || cellIds.some(id => reserved.includes(id))) throw new Error("接收区域已改接其他输入，请重新连接");
  while (axisCells().length < offset + entries.length) {
    if (alongRow) { columns.push(1); for (const row of cells) row.push({ ...emptyCanvasCell(), id: crypto.randomUUID() }); }
    else { weights.push(1); cells.push(columns.map(() => ({ ...emptyCanvasCell(), id: crypto.randomUUID() }))); }
  }
  for (const [i, entry] of entries.entries()) {
    const id = cellIds[i];
    const existing = cells.flat().find(cell => cell.id === id);
    const destination = existing ?? axisCells()[offset + i];
    if (!axisCells().includes(destination) || !existing && occupied(destination)) throw new Error("接收区域位置已改变，请重新连接");
    destination.id = id;
    destination.content_type = entry.type === "image" ? "image" : "text";
    destination.text = entry.type === "text" ? entry.text ?? "" : (entry.assetIds ?? []).map((_, n) => `@图片${n + 1}`).join(" ");
    destination.image_refs = entry.type === "text" ? entry.imageRefs ?? [] : (entry.assetIds ?? []).map((asset_id, n) => ({ asset_id, token: `@图片${n + 1}` }));
    if (entry.nodeIds?.[0]) destination.generation_ref = { session_node_id: entry.nodeIds[0] };
    else delete destination.generation_ref;
  }
  return { cellIds, tableCellIds: undefined, axisOffset: offset, axisCellIds: axisCells().map(cell => cell.id!),
    note: { ...note, note_type: "text" as const, cells, column_widths: columns, row_heights: weights, text: cells.map(row => row.map(cell => cell.text).join("\t")).join("\n") } };
}
