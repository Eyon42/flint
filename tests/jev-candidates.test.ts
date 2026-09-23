import { describe, expect, it } from "vitest";
import { createDocument } from "../src/lib/lint/documents.js";
import {
  chunkDocument,
  renderChunkCriteria,
  renderLineCriteria,
  renderNumberedLines,
  structuralSegments,
  type JevChunk,
} from "../src/lib/lint/rules/jev-candidates.js";
import { defined } from "./helpers.js";

function documentOf(lines: number) {
  const text = `${Array.from(
    { length: lines },
    (_, index) => `line ${index + 1}`,
  ).join("\n")}\n`;
  return createDocument("src/a.ts", text);
}

describe("structuralSegments", () => {
  it("splits on blank lines and top-level declarations", () => {
    const document = createDocument(
      "src/a.ts",
      "const a = 1;\n\nfunction b() {}\n",
    );
    expect(structuralSegments(document)).toEqual([
      { startLine: 1, endLine: 2 },
      { startLine: 3, endLine: 3 },
    ]);
  });

  it("does not split indented code", () => {
    const document = createDocument("src/a.ts", "if (x) {\n  foo();\n}\n");
    expect(structuralSegments(document)).toEqual([{ startLine: 1, endLine: 3 }]);
  });
});

describe("chunkDocument", () => {
  it("splits documents into contiguous chunks with a two-line overlap", () => {
    expect(chunkDocument(documentOf(30), { chunkLines: 15, maxChunks: 12 })).toEqual([
      { index: 1, startLine: 1, endLine: 15 },
      { index: 2, startLine: 14, endLine: 30 },
    ]);
  });

  it("allows a shorter last chunk", () => {
    expect(chunkDocument(documentOf(7), { chunkLines: 3, maxChunks: 12 })).toEqual([
      { index: 1, startLine: 1, endLine: 3 },
      { index: 2, startLine: 2, endLine: 6 },
      { index: 3, startLine: 5, endLine: 7 },
    ]);
  });

  it("returns one chunk for single-line and single-chunk files", () => {
    expect(chunkDocument(documentOf(1), { chunkLines: 15, maxChunks: 12 })).toEqual([
      { index: 1, startLine: 1, endLine: 1 },
    ]);
    expect(chunkDocument(documentOf(4), { chunkLines: 15, maxChunks: 12 })).toEqual([
      { index: 1, startLine: 1, endLine: 4 },
    ]);
  });

  it("ignores the phantom line after a trailing newline", () => {
    const chunks = chunkDocument(documentOf(3), { chunkLines: 3, maxChunks: 12 });
    expect(chunks).toEqual([{ index: 1, startLine: 1, endLine: 3 }]);
  });

  it("keeps structural boundaries and overlaps adjacent chunks", () => {
    const document = createDocument(
      "src/a.ts",
      "a1\na2\na3\n\na4\na5\na6\n\na7\na8\na9\n\na10\n",
    );
    expect(chunkDocument(document, { chunkLines: 3, maxChunks: 12 })).toEqual([
      { index: 1, startLine: 1, endLine: 3 },
      { index: 2, startLine: 2, endLine: 7 },
      { index: 3, startLine: 6, endLine: 11 },
      { index: 4, startLine: 10, endLine: 13 },
    ]);
  });

  it("caps the number of chunks at maxChunks", () => {
    const chunks = chunkDocument(documentOf(300), {
      chunkLines: 15,
      maxChunks: 12,
    });
    expect(chunks).toHaveLength(12);
    expect(chunks[0]).toEqual({ index: 1, startLine: 1, endLine: 25 });
    expect(defined(chunks.at(-1)).endLine).toBe(300);
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = defined(chunks[index - 1]);
      const current = defined(chunks[index]);
      expect(current.startLine).toBeGreaterThan(previous.startLine);
      expect(current.startLine).toBeLessThanOrEqual(previous.endLine + 1);
    }
  });
});

describe("renderChunkCriteria", () => {
  it("renders a compact range plus the first line", () => {
    const document = documentOf(3);
    const criteria = renderChunkCriteria(
      document,
      chunkDocument(document, { chunkLines: 2, maxChunks: 12 }),
    );

    expect(criteria["1"]).toBe("lines 1-2: line 1");
    expect(criteria["2"]).toBe("lines 2-3: line 2");
  });

  it("skips blank lines and truncates long lines", () => {
    const document = createDocument(
      "a.ts",
      `\n\nconst value = ${"x".repeat(200)};\n`,
    );
    const criteria = renderChunkCriteria(
      document,
      chunkDocument(document, { chunkLines: 3, maxChunks: 12 }),
    );
    const rendered = defined(criteria["1"]);
    expect(rendered.startsWith("lines 1-3: const value = xxx")).toBe(true);
    expect(rendered.endsWith("...")).toBe(true);
    expect(rendered.length).toBe("lines 1-3: ".length + 80);
  });
});

describe("renderLineCriteria", () => {
  it("renders labels when the state carries the text", () => {
    const document = documentOf(4);
    const chunk = defined(chunkDocument(document, { chunkLines: 15, maxChunks: 12 })[0]);

    expect(renderLineCriteria(document, chunk)).toEqual({
      "1": "line 1",
      "2": "line 2",
      "3": "line 3",
      "4": "line 4",
    });
    expect(renderLineCriteria(document, chunk, { includeText: true })["1"]).toBe(
      "line 1: line 1",
    );
  });

  it("covers only the given chunk", () => {
    const document = documentOf(4);
    const chunk: JevChunk = { index: 2, startLine: 3, endLine: 4 };

    expect(Object.keys(renderLineCriteria(document, chunk))).toEqual(["3", "4"]);
  });
});

describe("renderNumberedLines", () => {
  it("prefixes absolute line numbers", () => {
    expect(renderNumberedLines(documentOf(3), 2, 3)).toBe(
      "2 | line 2\n3 | line 3",
    );
  });
});
