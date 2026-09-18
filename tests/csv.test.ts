import { describe, expect, it } from "vitest";
import { escapeCsvCell, parseCsv, toCsv } from "../worker/lib/csv";

describe("parseCsv", () => {
  it("parses a simple table", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("handles quoted fields containing commas and newlines", () => {
    expect(parseCsv('a,b\n"x,y","line1\nline2"')).toEqual([
      ["a", "b"],
      ["x,y", "line1\nline2"],
    ]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([["a"], ['say "hi"']]);
  });

  it("strips a UTF-8 BOM so the first header is usable", () => {
    expect(parseCsv("﻿external_id,name\nAZ-1,佐藤")[0]).toEqual(["external_id", "name"]);
  });

  it("tolerates CRLF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("drops entirely blank rows", () => {
    expect(parseCsv("a,b\n\n1,2\n , \n")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

/** Strips RFC4180 quoting so the test can inspect the cell's actual content. */
function cellContent(escaped: string): string {
  if (!escaped.startsWith('"')) return escaped;
  return escaped.slice(1, -1).replace(/""/g, '"');
}

describe("escapeCsvCell — formula injection", () => {
  it("neutralises every formula-triggering prefix", () => {
    for (const payload of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) {
      // The apostrophe may sit inside RFC4180 quoting (e.g. for \r), so compare
      // the decoded content rather than the raw field.
      expect(cellContent(escapeCsvCell(payload)).startsWith("'")).toBe(true);
    }
  });

  it("neutralises the classic DDE payload", () => {
    const evil = "=cmd|' /C calc'!A0";
    const escaped = escapeCsvCell(evil);
    expect(cellContent(escaped).startsWith("'=cmd")).toBe(true);
    // No comma, quote or newline here, so no RFC4180 quoting is needed.
    expect(escaped).toBe("'=cmd|' /C calc'!A0");
  });

  it("still quotes a formula payload that also contains a comma", () => {
    const escaped = escapeCsvCell('=HYPERLINK("http://x","click")');
    expect(escaped.startsWith('"')).toBe(true);
    expect(cellContent(escaped).startsWith("'=HYPERLINK")).toBe(true);
  });

  it("leaves ordinary values alone", () => {
    expect(escapeCsvCell("佐藤 美咲")).toBe("佐藤 美咲");
    expect(escapeCsvCell(42)).toBe("42");
    expect(escapeCsvCell(null)).toBe("");
  });

  it("quotes and escapes embedded quotes", () => {
    expect(escapeCsvCell('a"b')).toBe('"a""b"');
  });
});

describe("toCsv", () => {
  it("emits a BOM so Excel reads UTF-8 correctly", () => {
    expect(toCsv(["氏名"], [["佐藤"]]).startsWith("﻿")).toBe(true);
  });

  it("round-trips through parseCsv, including a formula-shaped value", () => {
    const csv = toCsv(["a", "b"], [["=1+1", "x,y"]]);
    const rows = parseCsv(csv.slice(1));
    expect(rows[1]).toEqual(["'=1+1", "x,y"]);
  });
});
