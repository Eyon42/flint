import { lineText } from "../documents.js";
import type { Document } from "../types.js";
import { structuralSegments } from "./jev-candidates.js";

/** Conservative characters-per-token estimate for the request payload. */
export const CHARS_PER_TOKEN = 3;
/** Safety margin kept below the estimated context window. */
export const BUDGET_HEADROOM = 0.2;

export interface JevBudget {
  contextTokens: number;
  reservedOutputTokens: number;
}

export function requestBudgetChars(budget: JevBudget): number {
  const usable = Math.max(0, budget.contextTokens - budget.reservedOutputTokens);
  return Math.floor(usable * CHARS_PER_TOKEN * (1 - BUDGET_HEADROOM));
}

export function fitsBudget(payloadChars: number, budget: JevBudget): boolean {
  return payloadChars <= requestBudgetChars(budget);
}

export interface JevPart {
  index: number;
  startLine: number;
  endLine: number;
}

/** Serialized cost of a line, approximating JSON escaping of the state text. */
function lineCost(text: string): number {
  return JSON.stringify(text).length + 1;
}

function rangeChars(document: Document, startLine: number, endLine: number): number {
  let chars = 0;
  for (let line = startLine; line <= endLine; line += 1) {
    chars += lineCost(lineText(document, line));
  }
  return chars;
}

/**
 * Splits a document into contiguous, structurally aligned parts that each stay
 * under `maxPartChars`. Segments larger than the budget are split by line.
 * `oversized` reports a single line that cannot fit at any part size.
 */
export function partitionParts(
  document: Document,
  maxPartChars: number,
): { parts: JevPart[]; oversized: boolean } {
  const segments = structuralSegments(document);
  const raw: Array<{ start: number; end: number; chars: number }> = [];
  let current: { start: number; end: number; chars: number } | undefined;
  let oversized = false;

  const flush = (): void => {
    if (current) {
      raw.push(current);
      current = undefined;
    }
  };

  for (const segment of segments) {
    const chars = rangeChars(document, segment.startLine, segment.endLine);
    if (chars > maxPartChars) {
      flush();
      let start = segment.startLine;
      let used = 0;
      for (let line = segment.startLine; line <= segment.endLine; line += 1) {
        const lineChars = lineCost(lineText(document, line));
        if (lineChars > maxPartChars) {
          oversized = true;
        }
        if (used > 0 && used + lineChars > maxPartChars) {
          raw.push({ start, end: line - 1, chars: used });
          start = line;
          used = 0;
        }
        used += lineChars;
      }
      if (used > 0) {
        raw.push({ start, end: segment.endLine, chars: used });
      }
      continue;
    }

    if (current && current.chars + chars > maxPartChars) {
      flush();
    }
    if (!current) {
      current = { start: segment.startLine, end: segment.endLine, chars };
    } else {
      current.end = segment.endLine;
      current.chars += chars;
    }
  }
  flush();

  return {
    parts: raw.map((part, index) => ({
      index: index + 1,
      startLine: part.start,
      endLine: part.end,
    })),
    oversized,
  };
}

export interface QuestionGroup<T> {
  id: string;
  questions: Record<string, T>;
}

/**
 * Greedily packs question groups into payloads that satisfy `fits`. Returns
 * `undefined` when a single group cannot satisfy `fits` on its own, which
 * means batching cannot make progress.
 */
export function batchQuestionGroups<T>(
  groups: readonly QuestionGroup<T>[],
  fits: (questions: Record<string, T>) => boolean,
): Array<Record<string, T>> | undefined {
  const batches: Array<Record<string, T>> = [];
  let current: Record<string, T> = {};

  for (const group of groups) {
    const candidate = { ...current, ...group.questions };
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (Object.keys(current).length === 0) {
      return undefined;
    }
    batches.push(current);
    current = { ...group.questions };
    if (!fits(current)) {
      return undefined;
    }
  }

  if (Object.keys(current).length > 0) {
    batches.push(current);
  }
  return batches;
}
