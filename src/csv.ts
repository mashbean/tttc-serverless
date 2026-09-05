import type { SourceRow } from "./types";

export const MAX_COMMENT_CHARS = 2_000;
export const MAX_INTERVIEW_CHARS = 200;
export const MAX_ID_CHARS = 120;
export const MAX_CSV_BYTES = 3 * 1024 * 1024;

export class CsvError extends Error {}

/**
 * 解析 Talk to the City 的三欄 CSV（id,interview,comment）。interview 可省略；
 * 也接受欄位順序不同或多出的欄位（例如 timestamp），只要 id 與 comment 存在。
 */
export function parseSourceCsv(text: string, maxRows: number): SourceRow[] {
  if (typeof text !== "string") throw new CsvError("CSV 不是文字");
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  if (rows.length === 0) throw new CsvError("CSV 是空的");
  const headers = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const idIndex = headers.indexOf("id");
  const commentIndex = headers.indexOf("comment");
  const interviewIndex = headers.indexOf("interview");
  if (idIndex < 0 || commentIndex < 0) {
    throw new CsvError("CSV 需要 id 與 comment 兩欄（interview 可選），例如：id,interview,comment");
  }
  const body = rows.slice(1);
  if (body.length === 0) throw new CsvError("CSV 沒有資料列");
  if (body.length > maxRows) throw new CsvError(`這個部署每份報告最多 ${maxRows} 則發言，目前有 ${body.length} 則`);
  const seen = new Set<string>();
  const out: SourceRow[] = [];
  body.forEach((cells, index) => {
    const rowNumber = index + 2;
    const id = clean(cells[idIndex] ?? "", MAX_ID_CHARS);
    const comment = cleanMultiline(cells[commentIndex] ?? "", MAX_COMMENT_CHARS);
    const interview = interviewIndex >= 0 ? clean(cells[interviewIndex] ?? "", MAX_INTERVIEW_CHARS) : "";
    if (!id) throw new CsvError(`第 ${rowNumber} 列的 id 是空的`);
    if (seen.has(id)) throw new CsvError(`第 ${rowNumber} 列的 id 重複：${id}`);
    if (!comment) throw new CsvError(`第 ${rowNumber} 列的 comment 是空的`);
    seen.add(id);
    out.push({ seq: out.length, id, interview, comment });
  });
  return out;
}

/** 去掉控制字元與公式起始字元（避免下載 CSV 時被試算表當公式），壓縮空白。 */
function clean(value: string, max: number): string {
  return stripFormula(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\s+/g, " ").trim()).slice(0, max);
}

function cleanMultiline(value: string, max: number): string {
  return stripFormula(
    value
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\t ]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  ).slice(0, max);
}

function stripFormula(value: string): string {
  return value.replace(/^[=+\-@\t\r]+/, "");
}

export function csvCell(value: unknown): string {
  const text = String(value ?? "");
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csvTable(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

/** RFC 4180 解析：支援引號、跳脫引號、引號內換行；略過全空列。 */
export function parseCsv(value: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (quoted) {
      if (character === '"') {
        if (value[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (closedQuote) {
      if (character === ",") {
        row.push(field);
        field = "";
        closedQuote = false;
      } else if (character === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        closedQuote = false;
      } else if (character !== "\r") {
        throw new CsvError(`CSV 第 ${rows.length + 1} 列的引號欄位後有無效字元`);
      }
    } else if (character === '"') {
      if (field !== "") throw new CsvError(`CSV 第 ${rows.length + 1} 列的未加引號欄位含有引號`);
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }
  if (quoted) throw new CsvError("CSV 有未關閉的引號");
  if (field !== "" || row.length > 0 || closedQuote) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => cell !== ""));
}
