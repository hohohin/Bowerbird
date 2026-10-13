/** All rows are data, including a visible heading row. No header is inferred. */
export interface ContentTable {
  rows: string[][];
  title?: string;
  imageCells?: [number, number][];
  /** Read-only compatibility with previously saved Agent results. */
  columns?: string[];
}

export function contentTableRows(table: ContentTable): string[][] {
  return table.columns ? [table.columns, ...table.rows] : table.rows;
}

export function contentTableText(table: ContentTable): string {
  return JSON.stringify({ format: "bowerbird-table", ...(table.title ? { title: table.title } : {}), rows: contentTableRows(table) });
}

/** Spreadsheet TSV preserves quoted tabs/newlines; Markdown needs a separator row. */
export function parseTextTable(text: string): string[][] | null {
  const source = text.replace(/\r\n?/g, "\n");
  if (source.trimStart().startsWith("{")) {
    let value;
    try { value = JSON.parse(source); } catch { /* Ordinary text is not a table. */ }
    if (value?.format === "bowerbird-table") {
      const rows = Array.isArray(value.columns) && Array.isArray(value.rows) ? [value.columns, ...value.rows] : value.rows;
      if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0]) || !rows[0].length
        || rows.length * rows[0].length > 10000
        || !rows.every(row => Array.isArray(row) && row.length === rows[0].length && row.every(cell => typeof cell === "string"))) {
        throw new Error("表格需要完整、等长的二维单元格，最多 10000 格");
      }
      return rows;
    }
  }
  const lines = source.trim().split("\n");
  const markdownRow = (line: string) => {
    const cells = [""];
    const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "\\" && ["|", "\\"].includes(body[i + 1])) cells[cells.length - 1] += body[++i];
      else if (body[i] === "|") cells.push("");
      else cells[cells.length - 1] += body[i];
    }
    return cells.map(cell => cell.trim().replace(/<br\s*\/?\s*>/gi, "\n"));
  };
  if (lines.length >= 2 && lines[0].includes("|") && markdownRow(lines[1]).every(cell => /^:?-{3,}:?$/.test(cell))) {
    const rows = [lines[0], ...lines.slice(2)].map(markdownRow);
    if (rows.every(row => row.length === rows[0].length) && markdownRow(lines[1]).length === rows[0].length) return rows;
  }
  if (!source.includes("\t")) return null;
  const grid: string[][] = [];
  let row: string[] = [], value = "", quoted = false, separated = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"' && value === "") quoted = true;
    else if (ch === "\t") { row.push(value); value = ""; separated = true; }
    else if (ch === "\n") { row.push(value); grid.push(row); row = []; value = ""; }
    else value += ch;
  }
  if (quoted || !separated) return null;
  if (row.length || value || !source.endsWith("\n")) { row.push(value); grid.push(row); }
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  if (grid.length * width > 10000) throw new Error("表格不能超过 10000 个单元格");
  return grid.map(row => Array.from({ length: width }, (_, c) => row[c] ?? ""));
}
