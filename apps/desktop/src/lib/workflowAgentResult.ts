import type { WorkflowValue } from "./canvasWorkflow";

export interface AgentTable { title?: string; columns: string[]; rows: string[][] }

function validTable(value: AgentTable): boolean {
  return (value.title === undefined || typeof value.title === "string" && value.title.length <= 120)
    && Array.isArray(value.columns) && value.columns.length > 0 && value.columns.length <= 32
    && value.columns.every(cell => typeof cell === "string")
    && Array.isArray(value.rows) && value.rows.length > 0 && value.rows.length <= 100
    && value.rows.every(row => Array.isArray(row) && row.length === value.columns.length && row.every(cell => typeof cell === "string"));
}

/** Only a complete, rectangular table is inferred; surrounding prose is never discarded. */
function inferTable(text: string): AgentTable | undefined {
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const title = /^(?:#{1,6}\s+|[■●◆]\s*)/.test(lines[0] ?? "") ? lines.shift()!.replace(/^(?:#{1,6}\s+|[■●◆]\s*)/, "").trim() : undefined;
  if (title) while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length < 2 || lines.some(line => !line.trim())) return;
  const delimiter = lines[0].includes("｜") ? "｜" : lines[0].includes("\t") ? "\t" : "|";
  if (!lines.every(line => line.includes(delimiter))) return;
  const rows = lines.map(line => {
    if (delimiter !== "\t") line = line.trim();
    if (delimiter !== "\t" && line.startsWith(delimiter)) {
      line = line.slice(1);
      if (line.endsWith(delimiter) && !line.endsWith(`\\${delimiter}`)) line = line.slice(0, -1);
    }
    const cells = [""];
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "\\" && (line[i + 1] === delimiter || line[i + 1] === "\\")) cells[cells.length - 1] += line[++i];
      else if (line[i] === delimiter) cells.push("");
      else cells[cells.length - 1] += line[i];
    }
    return cells.map(cell => cell.trim().replace(/<br\s*\/?\s*>/gi, "\n"));
  });
  const columns = rows.shift()!;
  if (delimiter === "|" && rows[0]?.every(cell => /^:?-{3,}:?$/.test(cell)) && rows[0].length === columns.length) rows.shift();
  const table = { ...(title ? { title } : {}), columns, rows };
  return columns.length >= 2 && validTable(table) ? table : undefined;
}

/** Keep the v1 text envelope; structured tables travel inside text and retain a readable fallback. */
export function agentResultValue(text: string): WorkflowValue {
  if (typeof text !== "string" || !text.trim() || text.length > 16000) throw new Error("Agent 返回内容须为 1–16000 字");
  const raw = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { /* Ordinary text, including legacy delimited tables. */ }
  if (parsed?.format === "bowerbird-table") {
    if (Object.keys(parsed).some(key => !["format", "title", "columns", "rows"].includes(key)) || !validTable(parsed)) {
      throw new Error("Agent 表格格式无效：需要等长的文字行列，最多 32 列、100 行数据及 120 字标题");
    }
    const { format: _, ...table } = parsed as AgentTable & { format: string };
    return { type: "text", text: [table.title, [table.columns, ...table.rows].map(row => row.join("\t")).join("\n")].filter(Boolean).join("\n"), table };
  }
  const table = inferTable(text);
  return { type: "text", text, ...(table ? { table } : {}) };
}
