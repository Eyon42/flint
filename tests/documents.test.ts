import { describe, expect, it } from "vitest";
import {
  computeLineStarts,
  createDocument,
  guessLanguage,
  lineCount,
  lineRange,
  lineText,
  positionAt,
} from "../src/lib/lint/documents.js";

describe("computeLineStarts", () => {
  it("handles empty text", () => {
    expect(computeLineStarts("")).toEqual([0]);
  });

  it("tracks newline offsets", () => {
    expect(computeLineStarts("ab\ncd\n")).toEqual([0, 3, 6]);
  });
});

describe("createDocument", () => {
  it("infers the language from the extension", () => {
    expect(createDocument("a.ts", "").language).toBe("typescript");
    expect(createDocument("a.unknown", "").language).toBeUndefined();
  });
});

describe("positionAt", () => {
  const document = createDocument("a.ts", "one\ntwo\ncow");

  it("maps offsets to 1-based positions", () => {
    expect(positionAt(document, 0)).toEqual({ line: 1, column: 1 });
    expect(positionAt(document, 4)).toEqual({ line: 2, column: 1 });
    expect(positionAt(document, 9)).toEqual({ line: 3, column: 2 });
  });

  it("clamps out-of-range offsets", () => {
    expect(positionAt(document, -10)).toEqual({ line: 1, column: 1 });
    expect(positionAt(document, 999)).toEqual({ line: 3, column: 4 });
  });
});

describe("guessLanguage", () => {
  it("is case-insensitive", () => {
    expect(guessLanguage("A.TS")).toBe("typescript");
  });
});

describe("lineCount", () => {
  it("ignores the phantom line after a trailing newline", () => {
    expect(lineCount(createDocument("a.ts", ""))).toBe(1);
    expect(lineCount(createDocument("a.ts", "a"))).toBe(1);
    expect(lineCount(createDocument("a.ts", "a\n"))).toBe(1);
    expect(lineCount(createDocument("a.ts", "a\nb"))).toBe(2);
    expect(lineCount(createDocument("a.ts", "a\nb\n"))).toBe(2);
    expect(lineCount(createDocument("a.ts", "a\n\n"))).toBe(2);
  });
});

describe("lineText", () => {
  const document = createDocument("a.ts", "one\r\ntwo\nthree");

  it("returns lines without terminators", () => {
    expect(lineText(document, 1)).toBe("one");
    expect(lineText(document, 2)).toBe("two");
    expect(lineText(document, 3)).toBe("three");
  });

  it("clamps out-of-range lines", () => {
    expect(lineText(document, 0)).toBe("one");
    expect(lineText(document, 99)).toBe("three");
  });
});

describe("lineRange", () => {
  const document = createDocument("a.ts", "one\ntwo\n");

  it("spans a single line", () => {
    expect(lineRange(document, 2)).toEqual({
      line: 2,
      column: 1,
      endLine: 2,
      endColumn: 4,
    });
  });

  it("spans a range of lines", () => {
    expect(lineRange(document, 1, 2)).toEqual({
      line: 1,
      column: 1,
      endLine: 2,
      endColumn: 4,
    });
  });
});
