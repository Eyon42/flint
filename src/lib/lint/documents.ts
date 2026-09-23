import path from "node:path";
import type { DiagnosticRange, Document } from "./types.js";

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "c",
  ".cpp": "cpp",
  ".css": "css",
  ".go": "go",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "jsx",
  ".md": "markdown",
  ".mjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".sh": "shell",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".yaml": "yaml",
  ".yml": "yaml",
};

export function guessLanguage(filePath: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

export function createDocument(filePath: string, text: string): Document {
  return {
    path: filePath,
    text,
    lineStarts: computeLineStarts(text),
    language: guessLanguage(filePath),
  };
}

export function lineCount(document: Document): number {
  const count = document.lineStarts.length;
  if (count > 1 && document.text.endsWith("\n")) {
    return count - 1;
  }
  return count;
}

export function lineText(document: Document, line: number): string {
  const clamped = Math.max(1, Math.min(line, lineCount(document)));
  const start = document.lineStarts[clamped - 1] ?? 0;
  const rawEnd = document.lineStarts[clamped] ?? document.text.length;
  let end = rawEnd;
  while (
    end > start &&
    (document.text[end - 1] === "\n" || document.text[end - 1] === "\r")
  ) {
    end -= 1;
  }
  return document.text.slice(start, end);
}

export function lineRange(
  document: Document,
  line: number,
  endLine?: number,
): DiagnosticRange {
  const last = Math.max(line, endLine ?? line);
  return {
    line,
    column: 1,
    endLine: last,
    endColumn: lineText(document, last).length + 1,
  };
}

export function positionAt(
  document: Document,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, document.text.length));
  const starts = document.lineStarts;

  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= clamped) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return { line: low + 1, column: clamped - (starts[low] ?? 0) + 1 };
}
