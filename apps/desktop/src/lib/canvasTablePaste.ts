import { canvasGridWeights, emptyCanvasCell, type CanvasNotePayload } from "./canvasNotes";
import { parseTextTable } from "./contentTable";

const MAX_PASTE_CELLS = 10000;

function checkSize(rows: number, columns: number) {
  if (rows * columns > MAX_PASTE_CELLS) throw new Error("粘贴后的表格不能超过 10000 个单元格，请分成多张内容卡片");
}

/** Read text only from an inert clipboard fragment; never mount Office HTML. */
function cellText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  if (["SCRIPT", "STYLE"].includes(node.tagName)) return "";
  if (node.tagName === "BR") return "\n";
  let text = "", previousBlock = false;
  for (const child of Array.from(node.childNodes)) {
    const block = child instanceof Element && /^(P|DIV)$/.test(child.tagName);
    if ((block || previousBlock) && text && !text.endsWith("\n")) text += "\n";
    text += cellText(child);
    previousBlock = block;
  }
  return text;
}

/** HTML preserves single-column tables and merged-cell positions; TSV is the plain-text fallback. */
export function parseCanvasTableClipboard(html: string, text: string): string[][] | null {
  if (html) {
    const fragment = document.createElement("template");
    fragment.innerHTML = html;
    const table = fragment.content.querySelector("table");
    if (table) {
      const rows = Array.from(table.rows).filter(row => row.closest("table") === table);
      const grid: string[][] = [];
      for (const [r, row] of rows.entries()) {
        grid[r] ??= [];
        let c = 0;
        for (const cell of Array.from(row.cells)) {
          while (grid[r][c] !== undefined) c++;
          const height = Math.min(cell.rowSpan || rows.length - r, rows.length - r);
          const width = cell.colSpan;
          checkSize(rows.length, c + width);
          for (let y = r; y < r + height; y++) {
            grid[y] ??= [];
            for (let x = c; x < c + width; x++) grid[y][x] = "";
          }
          grid[r][c] = cellText(cell).replace(/\r\n?/g, "\n");
          c += width;
        }
      }
      const width = Math.max(0, ...grid.map(row => row.length));
      if (width) return grid.map(row => Array.from({ length: width }, (_, c) => row[c] ?? ""));
    }
  }
  return parseTextTable(text);
}

/** Replace only the pasted rectangle, retaining existing cell identities and sizing. */
export function pasteCanvasTable(note: CanvasNotePayload, table: string[][], row: number, column: number): CanvasNotePayload {
  const rows = Math.max(note.cells.length, row + table.length);
  const columns = Math.max(note.cells[0].length, column + table[0].length);
  checkSize(rows, columns);
  const cells = Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => {
    const cell = note.cells[r]?.[c] ?? { ...emptyCanvasCell(), id: crypto.randomUUID() };
    const text = table[r - row]?.[c - column];
    return text === undefined ? cell : { ...cell, content_type: "text" as const, text, image_refs: [] };
  }));
  const rowHeights = canvasGridWeights(note.row_heights, note.cells.length);
  const columnWidths = canvasGridWeights(note.column_widths, note.cells[0].length);
  return { ...note, note_type: "text", cells,
    row_heights: Array.from({ length: rows }, (_, r) => rowHeights[r] ?? 1),
    column_widths: Array.from({ length: columns }, (_, c) => columnWidths[c] ?? 1),
    text: cells.map(line => line.map(cell => cell.text).join("\t")).join("\n") };
}
