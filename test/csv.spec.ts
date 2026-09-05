import { describe, expect, it } from "vitest";
import { CsvError, csvTable, parseCsv, parseSourceCsv } from "../src/csv";

describe("source CSV", () => {
  it("accepts id,interview,comment and id,comment with extra columns in any order", () => {
    const rows = parseSourceCsv('comment,id,interview,timestamp\n"我家離核二廠不到五公里",a1,阿德,2026\n"第二則, 有逗號",a2,,2026\n', 100);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ seq: 0, id: "a1", interview: "阿德", comment: "我家離核二廠不到五公里" });
    expect(rows[1]).toMatchObject({ seq: 1, id: "a2", interview: "", comment: "第二則, 有逗號" });
    expect(parseSourceCsv("id,comment\n1,hi\n", 10)).toHaveLength(1);
  });

  it("rejects missing columns, blank comments, duplicate ids and too many rows", () => {
    expect(() => parseSourceCsv("statement_id,text\n1,x\n", 10)).toThrow(CsvError);
    expect(() => parseSourceCsv("id,comment\n1,\n", 10)).toThrow(/comment 是空的/);
    expect(() => parseSourceCsv("id,comment\n1,a\n1,b\n", 10)).toThrow(/重複/);
    expect(() => parseSourceCsv("id,comment\n1,a\n2,b\n", 1)).toThrow(/最多 1 則/);
  });

  it("strips a BOM, control characters and leading formula characters", () => {
    const rows = parseSourceCsv("﻿id,interview,comment\n1,=HYPERLINK,\"=cmd|' /C calc'!A0 rest\"\n", 10);
    expect(rows[0]?.interview).toBe("HYPERLINK");
    expect(rows[0]?.comment).toBe("cmd|' /C calc'!A0 rest");
  });

  it("parses RFC 4180 quoting and writes formula-safe cells", () => {
    expect(parseCsv('a,"b ""c""",d\n"multi\nline",,x\n')).toEqual([["a", 'b "c"', "d"], ["multi\nline", "", "x"]]);
    expect(() => parseCsv('a,"unterminated')).toThrow(CsvError);
    expect(csvTable(["x", "y"], [["=1+1", 'say "hi"']])).toBe('x,y\n\'=1+1,"say ""hi"""\n');
  });
});
