import { lineCount, lineText } from "../documents.js";
import type { Document } from "../types.js";

export interface JevChunk {
  index: number;
  startLine: number;
  endLine: number;
}

export interface JevChunkOptions {
  /** Target lines per chunk before `maxChunks` forces them larger. */
  chunkLines: number;
  /** Upper bound on chunks per document; adjacent chunks merge to satisfy it. */
  maxChunks: number;
}

/** Lines shared with the previous chunk, so boundary context stays visible. */
export const JEV_CHUNK_OVERLAP = 2;

export interface JevSegment {
  startLine: number;
  endLine: number;
}

const TOP_LEVEL_DECLARATION =
  /^(?:export|import|from|function|async|class|interface|type|const|let|var|describe|it|test|def|fn|pub|impl|struct|enum|trait|module|namespace|use|package|func|static|public|private|protected|@)/;

function isStructuralBoundary(document: Document, line: number): boolean {
  if (line <= 1) {
    return false;
  }
  if (lineText(document, line - 1).trim() === "") {
    return true;
  }
  const current = lineText(document, line);
  const trimmed = current.trim();
  if (trimmed === "" || current.length - current.trimStart().length > 0) {
    return false;
  }
  return TOP_LEVEL_DECLARATION.test(trimmed);
}

/**
 * Splits a document at heuristic structural boundaries: blank lines and
 * top-level declaration starts. Files without boundaries stay one segment.
 */
export function structuralSegments(document: Document): JevSegment[] {
  const total = lineCount(document);
  const segments: JevSegment[] = [];
  let start = 1;
  for (let line = 2; line <= total; line += 1) {
    if (isStructuralBoundary(document, line)) {
      segments.push({ startLine: start, endLine: line - 1 });
      start = line;
    }
  }
  segments.push({ startLine: start, endLine: total });
  return segments;
}

export function chunkDocument(
  document: Document,
  options: JevChunkOptions,
): JevChunk[] {
  const total = lineCount(document);
  const chunkLines = Math.max(1, Math.floor(options.chunkLines));
  const maxChunks = Math.max(1, Math.floor(options.maxChunks));
  const minSize = Math.max(chunkLines, Math.ceil(total / maxChunks));
  const segments = structuralSegments(document);

  const units: JevSegment[] = [];
  for (const segment of segments) {
    if (segment.endLine - segment.startLine + 1 <= minSize) {
      units.push(segment);
      continue;
    }
    for (
      let start = segment.startLine;
      start <= segment.endLine;
      start += minSize
    ) {
      units.push({
        startLine: start,
        endLine: Math.min(start + minSize - 1, segment.endLine),
      });
    }
  }

  const ranges: JevSegment[] = [];
  let current: JevSegment | undefined;
  let size = 0;

  for (const unit of units) {
    if (size === 0) {
      current = { startLine: unit.startLine, endLine: unit.endLine };
    } else if (current) {
      current.endLine = unit.endLine;
    }
    size += unit.endLine - unit.startLine + 1;
    if (size >= minSize && current) {
      ranges.push(current);
      current = undefined;
      size = 0;
    }
  }
  if (current) {
    ranges.push(current);
  }

  if (ranges.length > 1) {
    const last = ranges[ranges.length - 1];
    const previous = ranges[ranges.length - 2];
    if (
      last !== undefined &&
      previous !== undefined &&
      last.endLine - last.startLine + 1 < Math.max(1, Math.floor(minSize / 2))
    ) {
      previous.endLine = last.endLine;
      ranges.pop();
    }
  }

  return ranges.map((range, index) => {
    const previous = index > 0 ? ranges[index - 1] : undefined;
    const startLine =
      previous === undefined
        ? range.startLine
        : Math.max(previous.startLine + 1, range.startLine - JEV_CHUNK_OVERLAP);
    return { index: index + 1, startLine, endLine: range.endLine };
  });
}

const CRITERIA_LINE_MAX = 80;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function firstMeaningfulLine(document: Document, chunk: JevChunk): string {
  for (let line = chunk.startLine; line <= chunk.endLine; line += 1) {
    const text = lineText(document, line).trim();
    if (text !== "") {
      return truncate(text, CRITERIA_LINE_MAX);
    }
  }
  return truncate(lineText(document, chunk.startLine).trim(), CRITERIA_LINE_MAX);
}

export function renderChunkCriteria(
  document: Document,
  chunks: readonly JevChunk[],
): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const chunk of chunks) {
    criteria[String(chunk.index)] =
      `lines ${chunk.startLine}-${chunk.endLine}: ${firstMeaningfulLine(document, chunk)}`;
  }
  return criteria;
}

export interface JevLineCriteriaOptions {
  /** Repeat the line text when the state does not already carry it. */
  includeText?: boolean;
}

export function renderLineCriteria(
  document: Document,
  chunk: JevChunk,
  options: JevLineCriteriaOptions = {},
): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (let line = chunk.startLine; line <= chunk.endLine; line += 1) {
    criteria[String(line)] = options.includeText
      ? `line ${line}: ${lineText(document, line)}`
      : `line ${line}`;
  }
  return criteria;
}

/** Raw text for a line range, used as state when criteria carry the offsets. */
export function renderLines(
  document: Document,
  startLine: number,
  endLine: number,
): string {
  const lines: string[] = [];
  for (let line = startLine; line <= endLine; line += 1) {
    lines.push(lineText(document, line));
  }
  return lines.join("\n");
}

/** Number-prefixed text used as state for chunk-localized refinement. */
export function renderNumberedLines(
  document: Document,
  startLine: number,
  endLine: number,
): string {
  const lines: string[] = [];
  for (let line = startLine; line <= endLine; line += 1) {
    lines.push(`${line} | ${lineText(document, line)}`);
  }
  return lines.join("\n");
}
